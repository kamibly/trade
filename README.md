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
| 2 | Indicators, forecasts, combined score, signals, alerts while open | Next |
| 3 | Backtest, portfolio, stop-loss and take-profit, paper trading | Planned |
| 4 | OCI alert service: notifications when the app is closed, scanner | Planned |
| 5 | Machine learning (LightGBM, LSTM) on the server | Planned |

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
