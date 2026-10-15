// Scores every watchlist symbol on the alert timeframe while the app is open,
// reusing saved candles while they are fresh so the free data limits last.

import { analyze, signalAt, MIN_CANDLES } from './signals.js';
import { backtest } from './backtest.js';

// Method weights are re-learned from the backtest once a day per symbol.
export const WEIGHTS_MAX_AGE_MS = 24 * 3600_000;

// How old saved candles may be before a scan fetches new ones.
export const MAX_AGE_MS = { '15m': 5 * 60_000, '1h': 15 * 60_000, '1D': 60 * 60_000, '1W': 6 * 3600_000 };

export const isFresh = (saved, tf, now = Date.now()) => !!saved && now - saved.savedAt < MAX_AGE_MS[tf];

// An alert fires when the action changes into buy or sell, not on every scan.
export function alertFor(prevAction, action) {
  return action !== 'hold' && action !== prevAction ? action : null;
}

// Compact copy of a signal for storage and the Signals tab.
export function summarize(item, sig, tf) {
  return {
    key: `${item.type}:${item.symbol}`,
    symbol: item.symbol,
    name: item.name || item.symbol,
    type: item.type,
    tf,
    at: Date.now(),
    candleTime: sig.time,
    score: sig.score,
    action: sig.action,
    confidence: sig.confidence,
    entry: sig.entry,
    atr: sig.atr,
    stop: sig.stop,
    take: sig.take,
    top: sig.top,
  };
}

// deps: { getCandles, saveCandles, fetchCandles, getWeight?, saveWeight?, getModels? } so tests can stub them.
export async function scanItem(item, tf, settings, thresholds, deps, signal) {
  let saved = deps.getCandles(item, tf);
  if (!isFresh(saved, tf)) {
    try {
      const { candles } = await deps.fetchCandles(item, tf, settings, signal);
      deps.saveCandles(item, tf, candles);
      saved = { savedAt: Date.now(), candles };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (!saved) return { error: e.message };
    }
  }
  if (saved.candles.length < MIN_CANDLES) return { error: `Only ${saved.candles.length} candles, ${MIN_CANDLES} needed` };
  const S = analyze(saved.candles, { models: deps.getModels?.(tf) });
  let weights;
  if (deps.getWeight) {
    const w = deps.getWeight(item, tf);
    if (w && Date.now() - w.at < WEIGHTS_MAX_AGE_MS) weights = w.weights;
    else {
      const bt = backtest(S, { thresholds, stopAtr: settings.stopAtr, takeAtr: settings.takeAtr });
      if (bt) {
        weights = bt.weights;
        deps.saveWeight?.(item, tf, weights);
      }
    }
  }
  const sig = signalAt(S, saved.candles.length - 1, { thresholds, weights, stopAtr: settings.stopAtr, takeAtr: settings.takeAtr });
  return sig ? { result: summarize(item, sig, tf) } : { error: 'Not enough history' };
}
