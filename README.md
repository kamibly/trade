# Trade

A phone app for US stocks and crypto: live charts, a watchlist, and (in later
stages) prediction methods, buy and sell signals, and notifications from your
own server. It never places real trades.

**Trade gives decision support, not financial advice. No method predicts
prices reliably.**

Open it at **https://kamibly.github.io/Trade/**.

## Install on your phone

1. Open https://kamibly.github.io/Trade/ in Chrome on your phone.
2. Tap ⋮ then **Install app** (or **Add to Home screen**).
3. Open Trade from the new icon. It runs full screen and opens without a
   connection, showing the last prices it saved.

## Set up once

1. Get a free key at [twelvedata.com](https://twelvedata.com/register) (needed
   for stock prices; crypto needs no key).
2. In Trade, open **Settings**, paste the key and tap **Save and test**.

The free Twelve Data plan allows 8 requests a minute, so stock prices on a
long watchlist fill in over a minute or two. The key, your watchlist and your
settings stay in this phone's browser. Use **Settings → Save backup** to move
them to another phone.

## What's in it so far

| Stage | What | Status |
| --- | --- | --- |
| 1 | Installable app, watchlist, live charts (15m, 1H, 1D, 1W), USD and CAD | Done |
| 2 | Indicators, forecasts, combined score, signals, alerts while open | Done |
| 3 | Backtest, portfolio, stop-loss and take-profit, paper trading | Done |
| 4 | OCI alert service: notifications when the app is closed, scanner | Done |
| 5 | Machine learning (LightGBM, LSTM) on the server | Done |

## How signals work

Every method votes between -1 (sell) and +1 (buy). Votes are averaged inside
their group, then the six groups are averaged into a score from -100 to +100,
so a group with many methods can't outvote the rest.

| Group | Methods |
| --- | --- |
| Trend | SMA 20/50, EMA 50/200, price vs SMA 200, MACD, ADX, Ichimoku Cloud, Parabolic SAR, Supertrend |
| Momentum | RSI, Stochastic, Williams %R, CCI, rate of change, RSI divergence |
| Volatility | Bollinger Bands (and squeeze), Keltner Channels, Donchian breakout |
| Volume | On-balance volume, VWAP, money flow index, volume spikes |
| Price structure | Support and resistance, Fibonacci retracement, pivot points, candlestick patterns |
| Statistical forecasts | Linear regression, Holt-Winters smoothing, ARIMA(3,1,0), Monte Carlo (GBM), Hurst exponent |

A score of +40 or more is a buy and -40 or less a sell (both adjustable in
Settings). On random-walk prices the score stays within ±30 99% of the time,
while steady trends reach 35 to 50. Each signal suggests a stop-loss 2 × ATR
and a target 3 × ATR from the entry. Volume methods drop out when a source
has no volume (CoinGecko backup).

## Machine learning

With your server connected, a seventh group joins the vote: two models your
server trains every week (Sunday 03:00 by default) on your symbols plus a
spread of S&P 500 stocks and top cryptos, about 120 charts:

- **LightGBM** (gradient-boosted trees) reads the 30 method votes and a few
  indicator values (recent returns, ATR, RSI, ADX, distance from the 50 and
  200 SMA, Bollinger width, volume).
- **LSTM** (a small neural network) reads the last 32 candles' moves and
  volume changes.

Both predict whether the price is higher after fees 10 candles later. The
oldest ~70% of the history trains them and the newest ~30% tests them; a model
votes only if it was right more than half the time on at least 200 clear test
calls, and only on candles after its training period, so its backtest is out of
sample too. The phone downloads the models and runs them itself, so charts
and the in-app scanner use them as well. The chart's "Machine-learning models"
card shows each model's test result and whether it votes.

The **ML** chip on the chart draws an orange line to where the price went on
average, 10 candles later, after similar predictions in the models' test period,
with the share of those cases that rose after fees. Next to the Forecast fan
(which only extends the chart's own recent drift and volatility), it shows what
the learned models expect.

## Backtest, holdings and paper trading

- **Backtest.** Each chart splits its history: the older 60% measures how often
  each method's clear votes (|vote| ≥ 0.3) matched the move over the next 10
  candles, after 0.1% fees. A method right 50% of the time keeps weight 1, 60%
  doubles it, 40% or worse drops it to 0, and methods with few votes stay near 1.
  The newer 40% then trades the weighted score (long only, stop-loss, target or
  Sell score to exit) and is compared with equal weights and buy-and-hold.
  The scanner re-learns weights once a day per symbol.
- **My holdings.** What you own, with a stop-loss and target (from the Risk
  settings in ATRs if left empty). Alerts fire once when a stop or target is
  reached or a Sell signal appears. Held symbols are priced and scanned even if
  they are not on the watchlist.
- **Paper trading.** A pretend account ($10,000 by default) that buys on each
  new Buy signal, risking 1% of the account per trade with at most 20% in one
  symbol, and sells on the stop-loss, target or a Sell signal.

Holdings and the paper account live on the phone and are in the backup file.
With your server connected, the watchlist and holdings also sync to it.

## Your OCI server

[`server/`](server/) is trade-service, a Docker container that runs next to
jobspy-service. It sends alerts while the app is closed, scans the S&P 500 and
top 50 crypto 4 times a day, trains the machine-learning models weekly, and
syncs your watchlist and holdings. It scores
with copies of the app's own JavaScript (kept in step by `npm run sync-server`),
so its signals match the phone's. Only that folder goes to the VM, as
`trade_folder`, on host port 8898 (8004 inside the container). Setup steps are in
[server/README.md](server/README.md).

## Data sources

| Data | Source |
| --- | --- |
| US stocks | [Twelve Data](https://twelvedata.com) with your free key |
| Crypto candles | Coinbase Exchange, then Kraken, then CoinGecko as backups |
| Crypto prices and top-50 list | CoinGecko |
| USD to CAD | Frankfurter (European Central Bank), Coinbase as backup |

Charts use [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
(Apache 2.0, in `app/vendor/`).

## Hosting (one-time GitHub setup)

1. Make this repository public (Settings → General → Danger Zone). GitHub
   Pages on a free account needs a public repo. Keys and personal data never
   go in the repo.
2. Settings → Pages → Source: **GitHub Actions**.
3. Every push to `main` runs the tests and publishes `app/`.

## Development

The app is plain JavaScript with no build step.

```bash
npm test        # unit tests (Node 22)
npm run serve   # http://localhost:8080
```

When you change any file in `app/`, bump `CACHE` in `app/sw.js` so installed
phones pick up the new version.
