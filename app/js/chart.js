// Candlestick and volume chart, drawn with TradingView Lightweight Charts
// (loaded as a global from vendor/ so it works offline).

const UP = '#26a69a';
const DOWN = '#ef5350';

// The chart library shows times in UTC. Shift intraday candles to the phone's
// local time so 9:30 in New York reads as the local equivalent.
const toLocal = t => t - new Date(t * 1000).getTimezoneOffset() * 60;

export class PriceChart {
  constructor(el) {
    const LW = window.LightweightCharts;
    if (!LW) throw new Error('Chart library did not load');
    this.chart = LW.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: '#161b22' }, textColor: '#c9d1d9', fontSize: 12 },
      grid: { vertLines: { color: '#222a35' }, horzLines: { color: '#222a35' } },
      rightPriceScale: { borderColor: '#2a313c' },
      timeScale: { borderColor: '#2a313c', rightOffset: 4 },
      crosshair: { mode: LW.CrosshairMode.Normal },
      handleScroll: { vertTouchDrag: false },
    });
    this.candles = this.chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
    });
    this.volume = this.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.key = null;
  }

  // `key` identifies symbol + timeframe; the view is only re-fitted when it changes.
  setData(candles, { intraday, key, decimals }) {
    const shift = intraday ? toLocal : t => t;
    this.chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
    const minMove = Number((10 ** -decimals).toFixed(decimals));
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: decimals, minMove } });
    this.candles.setData(candles.map(c => ({ time: shift(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    const hasVolume = candles.some(c => c.volume > 0);
    this.volume.setData(hasVolume
      ? candles.map(c => ({ time: shift(c.time), value: c.volume, color: c.close >= c.open ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)' }))
      : []);
    if (key !== this.key) {
      this.key = key;
      const bars = Math.min(candles.length, 120);
      if (candles.length) this.chart.timeScale().setVisibleLogicalRange({ from: candles.length - bars, to: candles.length + 3 });
    }
  }

  clear() {
    this.candles.setData([]);
    this.volume.setData([]);
    this.key = null;
  }
}
