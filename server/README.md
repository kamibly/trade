# trade-service

The Trade app's helper on your OCI VM. It runs next to jobspy-service and:

- checks your watchlist and holdings right after every candle of your alert
  timeframe closes (and every 5 to 60 minutes in between), and sends app
  notifications for new Buy and Sell signals, even while the app is closed;
- checks your holdings' stop-loss and target every minute at the live price
  (stocks while the US market is open, crypto around the clock);
- runs the paper-trading account around the clock on the same signals, and
  buys each new buy idea from the scans (selling it on a later Sell), quiet
  hours included;
- scans every coin traded against the dollar on Coinbase or Kraken with at
  least $1M a day (no stablecoins) on the daily chart every 15 minutes, day and
  night; the coin list refreshes daily;
- watches every coin's price every minute (one request per exchange) and
  scores a coin again right away when it moves 1.5 ATR or more since its last
  scan;
- scans the S&P 500 on the daily chart every 30 minutes while the US market is
  open, plus once in the evening, and shows the best buy and sell ideas from
  both scans in the app's Signals tab;
- trains four machine-learning models per timeframe (LightGBM, an LSTM
  network, and bottom and top finders) every week and shares them with the app,
  plus a daily trade filter that the paper account uses once it passes its
  test on the newest year (an unfiltered shadow account judges it);
- tunes each symbol's buy and sell levels once a day (see the main README);
- keeps your watchlist, holdings and alert settings in sync between phones.

Scores come from the app's own JavaScript (`engine.mjs` runs copies of the
app's modules in `js/` with Node), so the server and the phone always agree.
The folder works on its own: it needs nothing else from the project.

Stock prices come from Yahoo Finance, which needs no key. When Yahoo refuses
(it answers 429 to a server it thinks asks too much), the server asks again the
way a browser does, then falls back to Nasdaq's public quotes for daily and
weekly charts and live prices. Nasdaq has no intraday history, so for 15m and
1H charts set a free Twelve Data key (`TWELVE_DATA_KEY`) as the backup. Or set
`STOCK_PROXY` so that, while Yahoo refuses the VM, these requests leave from a
home connection, which Yahoo rarely limits.
Crypto comes from Coinbase, Kraken and CoinGecko, as in the app.

Quiet hours (22:00 to 07:00, your time zone) hold back every alert except
stop-loss hits.

## Machine learning

Every week (`TRAIN_AT`, Sunday 03:00 by default), and soon after the first
start, the service trains models for every timeframe (15m, 1H, 1D and 1W), one
at a time, your alert timeframe first. Yahoo Finance only has about a month of
15-minute stock history, so 15m models may not pass their test. It learns from your watchlist and holdings plus
a spread of S&P 500 stocks and top cryptos (`TRAIN_SYMBOLS`, 120 charts).
The newest ~30% of that history tests the models; the app shows the result and
only lets a model vote if it was right more than half the time on at least 200
test calls. Models are saved in `trade_folder/trade-data/models/`.

Training runs in its own process for a few minutes and needs up to about
1 GB of memory while it runs, then gives it back. The compose snippet caps the
container at 1.5 GB so jobspy-service always keeps room. The image grows by several
hundred MB for the ML libraries (CPU-only PyTorch and LightGBM).

## 1. Copy this folder to the VM

Only this `server` folder goes to the VM, not the whole project. Put it next to
your `docker-compose.yml` (the one with jobspy-service) and name it
`trade_folder`:

```
docker-compose.yml
jobspy-service/
trade_folder/        <- this server folder
  Dockerfile
  main.py
  service.py
  engine.mjs
  js/
  ...
```

From your computer, for example:

```bash
git clone https://github.com/kamibly/Trade.git
scp -r Trade/server ubuntu@your-vm:~/your-stack/trade_folder
```

(Use your own user, host and stack folder.) You can leave out `tests/`; the
service doesn't need it.

## 2. Add the service to your stack

Copy the `trade-service` block from
[`docker-compose.snippet.yml`](docker-compose.snippet.yml) into your
`docker-compose.yml`, then set `TRADE_API_KEY` to a long random secret:

```bash
openssl rand -hex 32
```

Start it and check it answers:

```bash
docker compose up -d --build trade-service
curl http://localhost:8898/health
```

## 3. Create the notification keys

```bash
docker compose run --rm trade-service python generate_vapid_keys.py
```

Paste the two lines it prints into `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`
in `docker-compose.yml`, set `VAPID_SUBJECT` to `mailto:` and your email,
then restart:

```bash
docker compose up -d trade-service
```

Keep the private key secret. Changing the keys later means each phone has to
turn server alerts off and on again.

## 4. Open it through your OCI Load Balancer

The same way as jobspy-service:

1. OCI Console → Networking → Load Balancers → your load balancer.
2. **Backend Sets** → create one (for example `trade-backend`) pointing at the
   VM's private IP, port `8898` (the host port from the compose file, not
   `8004`, which is only the port inside the container). Health check: HTTP,
   port `8898`, path `/health`, method GET, status `200`.
   `/health` needs no key, so the load balancer can check it.
3. **Listeners** → create one on port `8898`, protocol
   HTTPS, with the same SSL certificate as your other listeners, forwarding to
   `trade-backend`.
4. **Security Lists / Network Security Groups** → allow ingress on port `8898`.

Then check from a browser: `https://your-name.duckdns.org:8898/health`.

## 5. Connect the app

In the app: Settings → **Your server**.

1. Enter the address (`https://your-name.duckdns.org:8898`) and your
   `TRADE_API_KEY`, then tap **Save and connect**. Your watchlist and holdings
   upload to the server.
2. Tap **Turn on server alerts** and allow notifications.
3. Tap **Send a test alert**. It should arrive within a few seconds.

With server alerts on, the app stops showing its own system notifications
(it still shows them on screen while open), so you don't get each alert twice.

## Settings

| Variable | What it does | Default |
| --- | --- | --- |
| `TRADE_API_KEY` | Secret the app sends as `X-API-Key` | required |
| `ALLOWED_ORIGIN` | The app's web address | `https://kamibly.github.io` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Notification keys from step 3 | none |
| `TRADE_TZ` | Time zone for quiet hours and scan times | `America/Toronto` |
| `MARKET_SCAN_TIMES` | When the S&P 500 scan runs, on weekdays | `09:45,10:15,10:45,11:15,11:45,12:15,12:45,13:15,13:45,14:15,14:45,15:15,15:45,20:00` |
| `CRYPTO_SCAN_MINUTES` | How often the crypto scan runs, around the clock | `15` |
| `TWELVE_DATA_KEY` | Backup for stocks Yahoo Finance can't serve | none |
| `STOCK_PROXY` | A fallback for Yahoo and Nasdaq: when they refuse the VM, their requests go through this proxy for the next 30 minutes, such as a Tailscale exit node at home (`http://host:port` or `socks5://host:port`). Nothing else uses it | none |
| `TRAIN_AT` | When the models retrain each week (day and local time) | `Sun 03:00` |
| `TRAIN_SYMBOLS` | How many charts the models learn from | `120` |
| `SEC_CONTACT` | Your email, which the SEC asks every program to send with its requests. Insider buying and earnings dates load only once it is set; it is sent only to the SEC | none |
| `NDAX_API_KEY`, `NDAX_API_SECRET`, `NDAX_USER_ID` | Real crypto orders on NDAX that follow the paper account's crypto trades. Create the key in NDAX under Settings, API Key, with trading permission only and no withdrawals; the user ID is under Personal User Info. Orders go out only in the app's Live mode | none |
| `IBKR_HOST`, `IBKR_PORT` | IB Gateway for stock orders on Interactive Brokers: the gateway's name on the Docker network (`ib-gateway`) and its paper API port (`4004`). Orders go out only in the app's Paper mode | none |

The opportunity setups' outside data refreshes every hour (Fear & Greed,
Kraken funding, new SEC Form 4 filings) and once a day (each company's earnings
filings, the Nasdaq calendar). The first start downloads two years of the
SEC's quarterly insider data sets (about 20 MB each, reduced to a small file).
It is kept in `trade_folder/trade-data/events/`. SEC requests stay under its
limit of 10 a second.

The watchlist and holdings are checked a minute after every candle of your
alert timeframe closes (a new Buy or Sell can only appear then), and also every
5 minutes (15m), 15 minutes (1H, 1D) or hour (1W) in between, and about 30
seconds after you change a setting or your watchlist. Stop-losses and
targets of holdings and paper trades are checked every minute. Checks run
whether or not a phone has server alerts on, so paper trading never stops;
alerts are only sent to phones that turned them on.

Each check runs on its own, so a market scan or the weekly training
never delays the minute checks.

Everything the service remembers (phones, synced holdings, last signals, scan
results) is in `trade_folder/trade-data/trade.json` on the VM, and the models
are in `trade_folder/trade-data/models/`.

## Updating later

Copy the new `server` folder over `trade_folder` (keep `trade_folder/trade-data`),
then rebuild:

```bash
docker compose up -d --build trade-service
```

## For development

`js/` holds copies of the app's modules from `app/js`, including `ml.js`,
which runs the models. After changing any of
them, run `npm run sync-server` from the project root; the tests fail while a
copy is out of date.

## Endpoints

All except `/health` need the `X-API-Key` header.

| Method and path | Use |
| --- | --- |
| `GET /health` | Load balancer check |
| `GET /status` | What Settings shows: phones, last checks, next scan |
| `GET /sync`, `PUT /sync` | Watchlist, holdings and alert settings |
| `GET /signals` | Last watchlist signals and the market scan |
| `GET /models` | The trained models, which the app runs on the phone |
| `POST /run` | Run now: `{"what": "watch"}`, `{"what": "market"}` (both scans), `{"what": "crypto"}`, `{"what": "train"}` or `{"what": "events"}` |
| `POST /feedback` | Rate an alert: `{"setups": ["insider"], "useful": false}` |
| `POST /setups/unmute` | Turn a muted setup's alerts back on: `{"setup": "insider"}` |
| `POST /push/subscribe`, `/push/unsubscribe`, `/push/test` | App notifications |

## Limits

- Yahoo Finance is free but unofficial. If it blocks the VM or changes, stock
  checks fail until it recovers; set `TWELVE_DATA_KEY` so the watchlist falls
  back to Twelve Data (8 symbols a minute, 800 a day on the free plan).
- A full market scan fetches about 550 charts and takes a few minutes.
- The models are only as good as their last test. Markets change, and a model
  that tested well can still be wrong for weeks.
- If the VM is down, no alerts arrive while the app is closed.

## Real crypto trading on NDAX

With the three `NDAX_*` variables set, the app's Settings shows your NDAX cash
and a **Real trading on NDAX** choice: Off, Dry run or Live.

- Every crypto buy and sell of the paper account is copied to NDAX in Canadian
  dollars. A buy gets the paper trade's share of the paper account, applied to
  your real budget, and never more than the per-trade limit, what is left of
  the budget or your CAD cash. Orders under $10 CAD, or under NDAX's own
  minimum, are skipped.
- The paper account's stop, target and trailing stop decide when to sell; the
  real coins are then sold at market.
- **Dry run** records the exact orders it would place, at NDAX's live prices,
  without sending them. **Live** sends them. Once today's live losses reach the
  daily limit, no new buys go out until tomorrow; sales still do.
- Turning it Off stops new buys; coins really bought are still sold when the
  paper account sells them.
- NDAX's list of coins (those sold for CAD) loads once a day without the key;
  crypto paper trades buy only those coins.

## Stock trading on Interactive Brokers (paper for now)

Add the `ib-gateway` service from `docker-compose.snippet.yml` with your IBKR
username and password, and set `IBKR_HOST` and `IBKR_PORT` on the trade
service. IB Gateway stays logged in to IBKR in paper mode and restarts each
night by itself. Its API is reachable only from the trade service, not from
outside the VM. The app's Settings then shows **Stock trading on IBKR**: Off or
Paper.

- Every stock buy and sell of the paper account is copied to your IBKR paper
  account in US dollars, in whole shares. A buy gets the paper trade's share of
  the paper account, applied to your budget, within the per-trade limit and
  what is left of the budget. If that comes to less than one share, one share is
  bought when it fits the per-trade limit, the budget left and the cash;
  otherwise the buy is skipped.
- If the gateway doesn't answer or hangs up, the server tries twice more, 5
  seconds apart. Orders connect as client 18 and the Settings check as client 17
  (IBKR_CLIENT_ID and the next number), so neither waits on the other.
- Orders are market orders. Outside market hours IBKR holds them until the
  open, and the app shows them as waiting until they fill.
- The paper account decides when to sell. A sale never sells more than IBKR
  actually holds, so it can't open a short.
- Paper mode refuses to send anything if the gateway is logged in to a live
  account (live accounts start with U, paper ones with D).
