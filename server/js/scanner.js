// Scores every watchlist symbol on the alert timeframe while the app is open,
// reusing saved candles while they are fresh so the free data limits last.

import { analyze, signalAt, breakdown, MIN_CANDLES } from './signals.js';
import { backtest } from './backtest.js';
import { feeRate } from './fees.js';

// Method weights are re-learned from the backtest once a day per symbol.
export const WEIGHTS_MAX_AGE_MS = 24 * 3600_000;

// How old saved candles may be before a scan fetches new ones.
export const MAX_AGE_MS = { '15m': 5 * 60_000, '1h': 15 * 60_000, '1D': 60 * 60_000, '1W': 6 * 3600_000 };

export const isFresh = (saved, tf, now = Date.now()) => !!saved && now - saved.savedAt < MAX_AGE_MS[tf];

// An alert fires when the action changes into buy or sell, not on every scan.
export function alertFor(prevAction, action) {
  return action !== 'hold' && action !== prevAction ? action : null;
}

// ---- Buy and Sell rules ---------------------------------------------------------
// Settings: tune 'auto' (default) picks thresholds and mode per symbol from its
// backtest; 'manual' uses buyAt, sellAt and mode for every symbol.

export const autoTune = settings => settings.tune !== 'manual';
export const manualRule = settings => ({ buy: settings.buyAt, sell: settings.sellAt, mode: settings.mode === 'dip' ? 'dip' : 'standard' });

// What a saved learning depends on besides the candles: change any of it and the backtest runs again.
// `fees2`: relearn once the per-broker fees came in.
export const learnKey = settings => `fees2:${autoTune(settings)
  ? `auto:${settings.stopAtr}:${settings.takeAtr}`
  : `manual:${settings.buyAt}:${settings.sellAt}:${settings.mode || 'standard'}:${settings.stopAtr}:${settings.takeAtr}`}`;

const brief = r => (r ? { ret: Number(r.totalReturn.toFixed(4)), trades: r.trades.length + (r.open ? 1 : 0) } : null);

// The track record of the rule a symbol trades with, on the test part of its
// backtest: { n, wins, avg, days } (days: average time in a trade).
export function tradeRecord(r) {
  if (!r || !r.trades.length) return null;
  const n = r.trades.length;
  const sum = r.trades.reduce((a, t) => a + t.ret, 0);
  const days = r.trades.reduce((a, t) => a + (t.exitTime - t.entryTime), 0) / n / 86400;
  return { n, wins: r.trades.filter(t => t.ret > 0).length, avg: Number((sum / n).toFixed(5)), days: Number(days.toFixed(2)) };
}

// "This signal on AAPL: won 14 of 21 test trades, average +2.1% over about 9 days."
export function tradeRecordLine(symbol, rec) {
  if (!rec || !rec.n) return '';
  const span = rec.days >= 1 ? `${Math.round(rec.days)} day${Math.round(rec.days) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(rec.days * 24))} hours`;
  const avg = `${rec.avg > 0 ? '+' : ''}${(rec.avg * 100).toFixed(1)}%`;
  return `This signal on ${symbol}: won ${rec.wins} of ${rec.n} test trades, average ${avg} over about ${span}.`;
}

// The backtest options for these settings (`votes` reuses a vote matrix).
export const backtestOptions = (settings, votes, type = 'stock') => ({
  thresholds: manualRule(settings), stopAtr: settings.stopAtr, takeAtr: settings.takeAtr, tune: autoTune(settings), votes, fee: feeRate(type),
});

// Method weights and, when tuning is on, this symbol's rule, from its backtest.
// result: { weights, rule, test: { tuned, standard }, key } (weights null when the history is too short)
export const learn = (S, settings, type) => learnedFrom(backtest(S, backtestOptions(settings, undefined, type)), settings);

export function learnedFrom(bt, settings) {
  return {
    weights: bt ? bt.weights : null,
    rule: bt && bt.rule ? bt.rule : null,
    test: bt && bt.tuned ? { tuned: brief(bt.tuned), standard: brief(bt.standard), from: bt.testFrom } : null,
    record: bt ? tradeRecord(bt.rule ? bt.tuned : bt.weighted) : null,
    key: learnKey(settings),
  };
}

// The rule a symbol trades with now.
export const ruleOf = (settings, learned) => (autoTune(settings) && learned && learned.rule ? learned.rule : manualRule(settings));

// Compact copy of a signal for storage and the Signals tab.
export function summarize(item, sig, tf, learned = null) {
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
    rule: sig.rule,
    ctx: sig.ctx,
    tuned: autoTuned(learned),
    record: (learned && learned.record) || null,
    // Buys and Sells keep how their score added up, for the paper trades they open or close.
    ...(sig.action !== 'hold' ? { why: breakdown(sig, (learned && learned.weights) || {}) } : {}),
  };
}

const autoTuned = learned => (learned && learned.rule ? { test: learned.test } : null);

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
  let learned = null;
  if (deps.getWeight) {
    const w = deps.getWeight(item, tf);
    if (w && Date.now() - w.at < WEIGHTS_MAX_AGE_MS && w.key === learnKey(settings)) learned = w;
    else {
      learned = learn(S, settings);
      deps.saveWeight?.(item, tf, learned);
    }
  }
  const rule = learned ? ruleOf(settings, learned) : thresholds;
  const sig = signalAt(S, saved.candles.length - 1, { thresholds: rule, weights: (learned && learned.weights) || undefined, stopAtr: settings.stopAtr, takeAtr: settings.takeAtr });
  return sig ? { result: summarize(item, sig, tf, learned) } : { error: 'Not enough history' };
}
