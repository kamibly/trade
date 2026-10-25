// How each method and model votes, in plain words, for the score breakdown.
// Every vote runs from −1 (strong Sell) to +1 (strong Buy); 0 means no opinion.
// ATR is the average true range: a chart's normal candle-to-candle swing.

export const METHOD_INFO = {
  'sma-cross': 'Compares the 20- and 50-candle averages. A fresh cross votes ±1; otherwise the gap between them, in ATRs.',
  'ema-cross': 'The 50- and 200-candle exponential averages (golden or death cross): their gap, measured in 2 ATRs.',
  sma200: 'How far the price is above or below its 200-candle average, measured in 3 ATRs.',
  macd: 'MACD histogram: a fresh cross of zero votes ±1; otherwise its size, measured in half an ATR.',
  adx: 'Trend strength. Below 20 there is no trend and it votes 0; above, it votes with the stronger direction (+DI or −DI), more as ADX rises to 40.',
  ichimoku: 'Price above the cloud votes Buy, below votes Sell, inside votes 0; half as much when the fast and slow lines disagree.',
  psar: 'Parabolic SAR: ±0.5 with its direction, ±1 on the candle it flips.',
  supertrend: 'Supertrend: ±0.6 with its direction, ±1 on the candle it flips.',
  rsi: 'RSI 14: under 30 (oversold) votes Buy, over 70 (overbought) votes Sell, more the further past the line; between, 0.',
  stoch: 'Stochastic %K: under 20 votes Buy (1 when %K turns up through %D), over 80 votes Sell; between, 0.',
  willr: 'Williams %R: under −80 votes +0.6, over −20 votes −0.6; between, 0.',
  cci: 'CCI: under −100 votes Buy, over +100 votes Sell, more the further past; between, 0.',
  roc: 'The move over the last 12 candles, compared with what normal swings would give over 12 candles.',
  'rsi-div': 'Divergence: a lower price low with a higher RSI low in the last 10 candles votes +0.8; the reverse at a high votes −0.8.',
  bollinger: 'Below the lower band votes +0.7, above the upper −0.7. In a squeeze (bands narrowest in 120 candles) ±0.5 toward the side of the middle line the price is on.',
  keltner: 'Closing above the channel (a breakout) votes +0.6, below −0.6; inside, 0.',
  donchian: 'A new 20-candle high votes +1, a new 20-candle low −1; inside the range, 0.',
  obv: 'On-balance volume over 20 candles: ±0.5 when volume confirms the price move, ±0.8 when it points against it.',
  vwap: 'Price above or below the 20-candle volume-weighted price, measured in 2 ATRs.',
  mfi: 'Money flow index: under 20 votes +0.7, over 80 votes −0.7; between, 0.',
  'vol-spike': 'Volume over twice its average votes ±0.7 with the candle\'s colour; normal volume, 0.',
  sr: 'Breaking above a recent swing high votes +0.8; within an ATR of support +0.6, of resistance −0.6; between levels, 0.',
  fib: 'In the 50–61.8% retracement zone of the last swing: +0.6 if that swing was a rise, −0.6 if a fall; outside it, 0.',
  pivots: 'Classic pivot points from the last candle: above R1 +0.5, below S1 −0.5, otherwise ±0.2 by the side of the pivot.',
  candles: 'A hammer or bullish engulfing after a fall votes +0.7; a shooting star or bearish engulfing after a rise −0.7.',
  linreg: 'The slope of a straight line through the last 100 closes, over 20 candles in ATRs, times how well the line fits (R²).',
  holt: 'Holt-Winters smoothing forecasts 10 candles ahead; votes the gap to today\'s price, measured in 2 ATRs.',
  arima: 'An ARIMA(3,1,0) model forecasts 10 candles ahead; votes the expected move against the normal 10-candle swing.',
  montecarlo: 'Simulates thousands of price paths from recent drift and volatility; votes (chance higher in 10 candles − 50%) × 4.',
  hurst: 'Hurst exponent: over 0.6 trends tend to persist, so it votes with the price\'s side of its 50-candle average; under 0.4 moves reverse, so it votes against it.',
  lgbm: 'LightGBM reads the 30 votes plus a few indicators and gives the chance the price is higher after fees in 10 candles. Its vote is that chance minus where its answers usually sit, divided by their usual spread.',
  lstm: 'An LSTM neural network reads the last 32 candles\' moves and volume and gives the same chance; it votes the same way as LightGBM.',
  bottom: 'Bottom finder: the chance a buy here reaches its target before its stop. It only votes Buy, when that chance is clearly above how often it happens anyway.',
  top: 'Top finder: the chance the price falls to a target before rising to a stop. It only votes Sell, when that chance is clearly above usual.',
};

export const SCORE_STEPS = [
  'Each method gives a vote from −1 (strong Sell) to +1 (strong Buy).',
  'Each vote has a weight from 0 to 2, set by this chart\'s backtest: the older part of its history counts how often the method\'s clear votes (±0.3 or more) pointed the right way after fees, 10 candles later. 50% right keeps weight 1, 60% or more doubles it, 40% or less drops it to 0 (no vote). With few votes the weight is pulled back toward 1: it keeps n ÷ (n + 50) of the change.',
  'Within each group, the votes are averaged using their weights: Σ(vote × weight) ÷ Σ weight.',
  'The groups count equally: score = 100 × the average of the group votes. So with 7 groups each can add up to about ±14 points.',
  'The score is compared with the Buy and Sell lines (tuned per chart when Auto is on) to give Buy, Hold or Sell.',
];
