# IBKR Web API fraction test

The goal is to see whether IBKR's Web API buys $10 of AAPL (about 0.03 shares) in the paper account. Nothing in the app or the server changes. The test takes about 15 minutes, while the US market is open (9:30–16:00 Toronto).

## 1. Before you start
1. Make sure the paper account allows fractions. In Client Portal, log in to the **paper** account and go to Settings, then Trading Permissions, then Stocks. Tick **Global (Trade in Fractions)**. It can take up to 24 h to switch on.
2. In the app, set **IBKR mode to Off** in Settings, so no orders are queued during the test.
3. On the VM, in `trade_folder`, stop IB Gateway: `docker compose stop ib-gateway`.
   IBKR allows only one session per login, so the test gateway would otherwise kick it off (or the other way round).

## 2. Start IBKR's Web API gateway on the VM
```
mkdir -p ~/ibkr-test && cd ~/ibkr-test
curl -LO https://download2.interactivebrokers.com/portal/clientportal.gw.zip
python3 -m zipfile -e clientportal.gw.zip cpgw
sed -i 's/listenPort: 5000/listenPort: 5002/' cpgw/root/conf.yaml
docker run --rm -it --network host -v "$PWD/cpgw:/gw" -w /gw eclipse-temurin:17-jre bash bin/run.sh root/conf.yaml
```
Leave that window open. When it's ready it prints a line about the server starting on port 5002.
Port 5002 stays private: no ingress rule is needed, so don't add one.

## 3. Log in through your browser
1. On your computer, open a second terminal and run `ssh -L 5002:localhost:5002 <your usual VM login>`. Use the same login you normally use to SSH in.
2. In your browser, open **https://localhost:5002**. Accept the certificate warning, since this is IBKR's own self-signed certificate.
3. Log in to the **paper** account, either with the Paper switch on the login page or with your paper username. Approve 2FA if asked.
4. The page should say **Client login succeeds**.

## 4. Run the test
1. Copy `fraction_test.py` to `~/ibkr-test` on the VM. On GitHub, open the file, click **Raw**, and copy it into `nano ~/ibkr-test/fraction_test.py`.
2. In a third terminal on the VM, run:
```
cd ~/ibkr-test
python3 fraction_test.py
```
   If `python3` isn't on the VM, run this instead: `docker run --rm --network host -v "$PWD:/t" python:3.12-slim python /t/fraction_test.py`
3. Paste everything it prints into the thread. The last line starts with **RESULT**.
4. To sell the fraction again, run `python3 fraction_test.py --sell`. This also tests a fractional sale.

The script refuses to run on anything except a paper account (DU…).

## 5. Put things back
1. Stop the test gateway with Ctrl+C in its window, then close the SSH tunnel.
2. Start IB Gateway again: `docker compose start ib-gateway`.
3. Set IBKR mode back to Paper in the app.
