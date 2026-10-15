# trade-service

The Trade app's helper on your OCI VM. It runs next to jobspy-service and:

- checks your watchlist and holdings every 5 to 60 minutes (by your alert
  timeframe) and sends app notifications for new Buy and Sell signals,
  stop-loss hits and targets reached, even while the app is closed;
- scans the S&P 500 and the top 50 crypto on the daily chart 4 times a day
  and shows the best buy and sell ideas in the app's Signals tab;
- keeps your watchlist, holdings and alert settings in sync between phones.

Scores come from the app's own JavaScript (`engine.mjs` runs copies of the
app's modules in `js/` with Node), so the server and the phone always agree.
The folder works on its own: it needs nothing else from the project.

Stock prices come from Yahoo Finance, which needs no key; a Twelve Data key is
an optional backup.
Crypto comes from Coinbase, Kraken and CoinGecko, as in the app.

Quiet hours (22:00 to 07:00, your time zone) hold back every alert except
stop-loss hits.

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
curl http://localhost:8004/health
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
   VM's private IP, port `8004`. Health check: HTTP, port `8004`, path
   `/health`, method GET, status `200`.
   `/health` needs no key, so the load balancer can check it.
3. **Listeners** → create one on port `8004`, protocol
   HTTPS, with the same SSL certificate as your other listeners, forwarding to
   `trade-backend`.
4. **Security Lists / Network Security Groups** → allow ingress on port `8004`.

Then check from a browser: `https://your-name.duckdns.org:8004/health`.

## 5. Connect the app

In the app: Settings → **Your server**.

1. Enter the address (`https://your-name.duckdns.org:8004`) and your
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
| `MARKET_SCAN_TIMES` | When the S&P 500 and top-50 crypto scan runs | `09:45,12:30,15:45,20:00` |
| `TWELVE_DATA_KEY` | Backup for stocks Yahoo Finance can't serve | none |

How often the watchlist and holdings are checked follows the alert timeframe
in the app: 15m every 5 minutes, 1H and 1D every 15 minutes, 1W every hour.
Checks only run while at least one phone has server alerts on.

Everything the service remembers (phones, synced holdings, last signals, scan
results) is in `trade_folder/trade-data/trade.json` on the VM.

## Updating later

Copy the new `server` folder over `trade_folder` (keep `trade_folder/trade-data`),
then rebuild:

```bash
docker compose up -d --build trade-service
```

## For development

`js/` holds copies of the app's modules from `app/js`. After changing any of
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
| `POST /run` | Run now: `{"what": "watch"}` or `{"what": "market"}` |
| `POST /push/subscribe`, `/push/unsubscribe`, `/push/test` | App notifications |

## Limits

- Yahoo Finance is free but unofficial. If it blocks the VM or changes, stock
  checks fail until it recovers; set `TWELVE_DATA_KEY` so the watchlist falls
  back to Twelve Data (8 symbols a minute, 800 a day on the free plan).
- A full market scan fetches about 550 charts and takes a few minutes.
- If the VM is down, no alerts arrive while the app is closed.
