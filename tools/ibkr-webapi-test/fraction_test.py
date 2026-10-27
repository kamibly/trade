#!/usr/bin/env python3
"""One-off test: can IBKR's Web API (Client Portal Gateway) buy a fraction of a share?

Run on the VM while the gateway is logged in at https://localhost:5002.
  python3 fraction_test.py            buys $10 of AAPL in the paper account
  python3 fraction_test.py --sell     sells the AAPL fraction it bought
Only a paper account (DU...) is ever used. Python 3 standard library only.
"""
import json
import ssl
import sys
import time
import urllib.error
import urllib.request

BASE = "https://localhost:5002/v1/api"
SYMBOL = "AAPL"
USD = 10
CTX = ssl._create_unverified_context()   # the gateway uses a self-signed certificate on localhost


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "trade-test"})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=30) as r:
            text = r.read().decode()
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        print(f"  {method} {path} -> HTTP {e.code}: {text[:300]}")
    except urllib.error.URLError as e:
        sys.exit(f"Can't reach the gateway at {BASE} ({e.reason}). Is it running?")
    try:
        return json.loads(text) if text else None
    except ValueError:
        return text


def place(acct, order):
    r = call("POST", f"/iserver/account/{acct}/orders", {"orders": [order]})
    for _ in range(5):                    # IBKR asks "are you sure?" questions; answer yes
        if isinstance(r, list) and r and "message" in r[0] and "id" in r[0]:
            print("  IBKR asks:", " / ".join(r[0]["message"]))
            r = call("POST", f"/iserver/reply/{r[0]['id']}", {"confirmed": True})
        else:
            break
    print("  Order reply:", json.dumps(r)[:400])
    if isinstance(r, list) and r and r[0].get("order_id"):
        return r[0]["order_id"]
    return None


def watch(order_id):
    for _ in range(10):
        time.sleep(3)
        orders = (call("GET", "/iserver/account/orders?force=true") or {}).get("orders") or []
        mine = [o for o in orders if str(o.get("orderId")) == str(order_id)]
        if mine:
            o = mine[0]
            print(f"  Status {o.get('status')}, filled {o.get('filledQuantity')}, left {o.get('remainingQuantity')}, price {o.get('avgPrice')}")
            if o.get("status") in ("Filled", "Cancelled", "Inactive", "Rejected"):
                return o
    return None


def held(acct, conid):
    time.sleep(3)
    for p in call("GET", f"/portfolio/{acct}/positions/0") or []:
        if p.get("conid") == conid:
            return float(p.get("position") or 0)
    return 0.0


def main():
    sell = "--sell" in sys.argv
    status = call("GET", "/iserver/auth/status") or {}
    if not status.get("authenticated"):
        sys.exit("The gateway is running but not logged in. Log in at https://localhost:5002 first.")
    accts = (call("GET", "/iserver/accounts") or {}).get("accounts") or []
    acct = next((a for a in accts if a.startswith("DU")), None)
    if not acct:
        sys.exit(f"No paper account (DU...) on this login: {accts}. Log in with the paper login. Nothing was sent.")
    print("Paper account:", acct)

    stocks = (call("GET", f"/trsrv/stocks?symbols={SYMBOL}") or {}).get(SYMBOL) or []
    conid = next((c["conid"] for s in stocks for c in s.get("contracts", []) if c.get("isUS")), None)
    if not conid:
        sys.exit(f"Couldn't find {SYMBOL}'s contract id.")
    print(f"{SYMBOL} contract id:", conid)

    rules = call("POST", "/iserver/contract/rules", {"conid": conid, "isBuy": not sell}) or {}
    print("  Cash-amount order types:", rules.get("cqtTypes"), "| size step:", rules.get("sizeIncrement"),
          "| fractional step:", rules.get("fraqInt"), rules.get("fraqTypes"))

    if sell:
        qty = held(acct, conid)
        if qty <= 0:
            sys.exit(f"No {SYMBOL} held in {acct}; nothing to sell.")
        print(f"Selling {qty} {SYMBOL}...")
        order = {"conid": conid, "orderType": "MKT", "side": "SELL", "tif": "DAY", "quantity": qty}
    else:
        before = held(acct, conid)
        print(f"Holding {before} {SYMBOL}. Buying ${USD} worth...")
        order = {"conid": conid, "orderType": "MKT", "side": "BUY", "tif": "DAY", "cashQty": USD}

    oid = place(acct, order)
    if not oid:
        print("\nRESULT: IBKR did not accept the order (see the reply above).")
        return
    o = watch(oid)
    after = held(acct, conid)
    print(f"Now holding {after} {SYMBOL}.")
    if sell:
        print("\nRESULT:", "the fraction was sold." if after < qty else "nothing was sold yet (see status above).")
        return
    bought = round(after - before, 6)
    if o is None or o.get("status") != "Filled":
        print("\nRESULT: the order didn't fill in 30 s. Copy the lines above to Claude.")
    elif bought and bought != int(bought):
        print(f"\nRESULT: fractions work. Bought {bought} {SYMBOL} for about ${USD}.")
    else:
        print(f"\nRESULT: no fraction. Bought {bought} shares (rounded to whole shares).")


if __name__ == "__main__":
    main()
