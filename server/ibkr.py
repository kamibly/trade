"""
Stock orders on Interactive Brokers that follow the paper account.

When the paper account buys or sells a stock, the same trade is placed on
IBKR through IBKR's Web API, sized from your budget in US dollars. Buys are
sent as a dollar amount, so IBKR buys fractional shares; sales sell the
fraction held. The Web API runs in IBeam, a second container on the VM that
logs in to IBKR with a headless browser. For now only a paper IBKR account is
traded: "Paper" in the app's Settings refuses to send orders if the login is
a live account (live accounts start with U, paper ones with D). Stops and
targets stay with the app's paper account: when it sells, the shares are sold
at market.

Logging in: IBKR asks you to approve each login in IBKR Mobile (IB Key),
about once a day. IBeam starts idle, with IBKR's gateway stopped. "Log in to
IBKR" in Settings wakes it (ask_login); it starts the gateway, logs in, and
IBKR Mobile asks for your fingerprint. While logged in, IBeam keeps the
session going. When the session ends without you asking, keep_alive puts
IBeam back to idle before it can log in by itself, and you get an alert to log
in again.

Environment variables for this service (the IBKR username and password go to
the ibeam container, not here; see docker-compose.snippet.yml):
    IBKR_WEB_URL   - the Web API gateway in the ibeam container, e.g. https://ibeam:5000 (unset: IBKR off)
    IBKR_IBEAM_URL - IBeam's own control port, e.g. http://ibeam:5001

Saved state, under state["ibkr"]:
    positions - key -> what was really bought: { symbol, qty, usd, at, mode, id, status }
    orders    - the latest orders, newest first: { at, key, symbol, side, mode, status, usd, qty, price, fee, pnl, error, id }
    account   - { id, paper, currency, available, net } at the last check
"""
import json
import logging
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Callable, Dict, List, Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger("trade-service")

WEB_URL = os.environ.get("IBKR_WEB_URL", "").rstrip("/")
IBEAM_URL = os.environ.get("IBKR_IBEAM_URL", "").rstrip("/")
CONNECT_TRIES = 3
CONNECT_RETRY_S = 5       # the gateway can drop a request (it did once at the market open)
REQUEST_TIMEOUT_S = 30    # an unanswered request gives up; one once held _lock for 14 hours
STUCK_MS = 5 * 60_000     # the IBKR lock held longer than this is reported as stuck
MIN_ORDER_USD = 10
QTY_DECIMALS = 4          # IBKR fractional shares go to 4 decimal places
FILL_WAIT_S = 20          # a market order outside market hours waits for the open ("working")
ACCOUNT_EVERY_MS = 60_000
KEEP_ORDERS = 100
MODES = ("off", "paper")
LOGIN_WINDOW_MS = 6 * 60_000    # IBeam resends the IB Key notification for about 5 minutes
OPEN_STATUSES = ("Submitted", "PreSubmitted", "PendingSubmit", "ApiPending")
# The gateway in the ibeam container has its own self-signed certificate; it is
# only reached inside the VM's Docker network.
_SSL = ssl._create_unverified_context()

_lock = threading.Lock()
_busy = {"since": None, "what": None}   # who holds _lock, for Settings when it seems stuck


def _take(what: str) -> bool:
    if not _lock.acquire(blocking=False):
        return False
    _busy.update(since=now_ms(), what=what)
    return True


def _give() -> None:
    _busy.update(since=None, what=None)
    _lock.release()


def configured() -> bool:
    return bool(WEB_URL)


def ib_symbol(symbol: str) -> str:
    """IBKR writes class shares with a space: BRK.B is "BRK B"."""
    return symbol.replace(".", " ").replace("-", " ")


def fee_estimate(qty: float, price: float) -> float:
    """IBKR Pro Fixed: $0.005 a share, at least $1, at most 1% of the trade."""
    value = qty * price
    return round(min(max(0.005 * qty, 1.0), 0.01 * value), 2) if value > 0 else 0.0


class LoggedOut(Exception):
    """IBKR's Web API answers but nobody is logged in."""


def http(method: str, url: str, body=None, timeout: float = REQUEST_TIMEOUT_S):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "trade-service"})
    try:
        with urllib.request.urlopen(req, context=_SSL if url.startswith("https") else None, timeout=timeout) as r:
            text = r.read().decode()
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        if e.code == 401:
            raise LoggedOut("IBKR is not logged in") from None
        try:
            err = json.loads(text).get("error")
        except (ValueError, AttributeError):
            err = None
        raise RuntimeError(f"IBKR: {err}" if err else f"IBKR answered {e.code}: {text[:120]}") from None
    except urllib.error.URLError as e:
        # IBeam runs IBKR's gateway only while it is logged in or logging in.
        if isinstance(e.reason, ConnectionRefusedError) and url.startswith(WEB_URL or "-"):
            raise LoggedOut("IBKR is not logged in") from None
        raise
    return json.loads(text) if text.strip() else None


def _num(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class Gateway:
    """The few Web API calls the app needs. Tests use a fake with the same methods."""

    def __init__(self):
        status = self.get("/iserver/auth/status") or {}
        if not status.get("authenticated"):
            raise LoggedOut("IBKR is not logged in")
        accts = self.get("/iserver/accounts") or {}   # IBKR wants this before any order
        self.account = accts.get("selectedAccount") or (accts.get("accounts") or [None])[0]
        if not self.account:
            raise RuntimeError("IBKR's login has no account")
        self.get("/portfolio/accounts")               # and this before the portfolio calls
        self._conids: Dict[str, int] = {}

    def get(self, path: str):
        return http("GET", WEB_URL + "/v1/api" + path)

    def post(self, path: str, body=None):
        return http("POST", WEB_URL + "/v1/api" + path, body if body is not None else {})

    def close(self) -> None:
        pass   # IBeam keeps the session; nothing to close

    def funds(self) -> dict:
        s = self.get(f"/portfolio/{self.account}/summary") or {}
        avail, net = s.get("availablefunds") or {}, s.get("netliquidation") or {}
        return {"currency": avail.get("currency") or net.get("currency"), "available": _num(avail.get("amount")), "net": _num(net.get("amount"))}

    def positions(self) -> Dict[str, float]:
        try:
            self.post(f"/portfolio/{self.account}/positions/invalidate")   # IBKR caches positions; ask for fresh ones
        except Exception:  # noqa: BLE001
            pass
        out: Dict[str, float] = {}
        for p in self.get(f"/portfolio/{self.account}/positions/0") or []:
            name = p.get("ticker") or p.get("contractDesc") or ""
            if p.get("assetClass") == "STK" and _num(p.get("position")):
                out[name.replace(" ", ".")] = float(p["position"])
        return out

    def conid(self, symbol: str) -> int:
        if symbol not in self._conids:
            name = ib_symbol(symbol)
            found = (self.get(f"/trsrv/stocks?symbols={urllib.parse.quote(name)}") or {}).get(name) or []
            ids = [c["conid"] for s in found for c in s.get("contracts", []) if c.get("isUS")]
            if not ids:
                raise RuntimeError(f"IBKR doesn't know {symbol}")
            self._conids[symbol] = ids[0]
        return self._conids[symbol]

    def order(self, symbol: str, side: str, qty: Optional[float] = None, usd: Optional[float] = None) -> dict:
        """A market order, for a number of shares or (buys) a dollar amount."""
        order = {"conid": self.conid(symbol), "orderType": "MKT", "side": side.upper(), "tif": "DAY"}
        order.update(cashQty=usd) if usd is not None else order.update(quantity=qty)
        r = self.post(f"/iserver/account/{self.account}/orders", {"orders": [order]})
        for _ in range(5):   # IBKR asks "are you sure?" (fractional order, market closed...): yes
            if isinstance(r, list) and r and r[0].get("id") and r[0].get("message"):
                r = self.post(f"/iserver/reply/{r[0]['id']}", {"confirmed": True})
            else:
                break
        first = r[0] if isinstance(r, list) and r else (r or {})
        if first.get("error") or not first.get("order_id"):
            return {"status": "failed", "error": f"IBKR: {first.get('error') or first}"[:200]}
        oid = str(first["order_id"])
        st = {}
        waited = 0.0
        while waited < FILL_WAIT_S:
            st = self.get(f"/iserver/account/order/status/{oid}") or {}
            if st.get("order_status") not in OPEN_STATUSES:
                break
            time.sleep(1)
            waited += 1
        status = st.get("order_status")
        filled, price = _num(st.get("cum_fill")) or 0.0, _num(st.get("average_price")) or 0.0
        if status == "Filled":
            return {"status": "filled", "filled": filled, "price": price, "fee": self.fee(oid), "id": oid}
        if status in OPEN_STATUSES:
            # Market closed: the order waits for the open.
            return {"status": "working", "filled": filled, "price": price, "id": oid}
        return {"status": "failed", "error": f"IBKR: order {str(status or 'not confirmed').lower()}", "id": oid}

    def fee(self, oid: str) -> Optional[float]:
        try:
            fees = [_num(t.get("commission")) for t in self.get("/iserver/account/trades") or [] if str(t.get("order_id")) == oid]
        except Exception:  # noqa: BLE001
            return None
        return sum(f for f in fees if f) or None

    def working(self) -> set:
        self.get("/iserver/account/orders")   # the first call only starts IBKR's order list
        time.sleep(1)
        orders = (self.get("/iserver/account/orders") or {}).get("orders") or []
        return {str(o.get("orderId")) for o in orders if o.get("status") in OPEN_STATUSES}


# The daily login. The state is in memory: a restart simply asks you to log in again.
_login = {"asked": None, "alerted": False, "checkedAt": 0}


def _ibeam(path: str) -> bool:
    if not IBEAM_URL:
        return False
    try:
        http("GET", IBEAM_URL + path, timeout=10)
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("IBeam %s failed: %s", path, error_text(e))
        return False


def ask_login() -> dict:
    """"Log in to IBKR" in Settings: wakes IBeam, which logs in within a minute
    and sends the IB Key notification to IBKR Mobile."""
    if not IBEAM_URL:
        return {"ok": False, "error": "IBeam is not set up on the server (IBKR_IBEAM_URL)"}
    _login.update(asked=now_ms(), alerted=False)
    ok = _ibeam("/activate")
    return {"ok": ok, "error": None if ok else "IBeam didn't answer"}


def keep_alive(alert: Callable[[str, str], None], every_ms: int = 15_000) -> None:
    """Run by the scheduler. While logged in, IBeam keeps the session going.
    When the session ends without you asking to log in, IBeam is put back to
    idle before it tries to log in by itself, so a session that runs out at
    night doesn't send IB Key notifications over and over; you get one alert.
    A login you don't approve in time is stopped the same way."""
    now = now_ms()
    if not configured() or now - _login["checkedAt"] < every_ms:
        return
    _login["checkedAt"] = now
    try:
        authed = bool((http("GET", WEB_URL + "/v1/api/iserver/auth/status") or {}).get("authenticated"))
    except LoggedOut:
        authed = False
    except Exception as e:  # noqa: BLE001 - the gateway doesn't answer: try again next time
        logger.info("IBKR's Web API didn't answer the check: %s", error_text(e))
        return
    asked = _login["asked"]
    if authed:
        _login.update(asked=None, alerted=False)
        return
    if asked and now - asked < LOGIN_WINDOW_MS:
        return   # IBeam is logging in, or waiting for you to approve
    _login["asked"] = None
    if not _login["alerted"]:
        _login["alerted"] = True
        _ibeam("/deactivate")
        alert("IBKR logged out", "Stock orders wait until you log in again from the app's Settings.")


def login_info() -> dict:
    asked = _login["asked"]
    return {"loggingIn": bool(asked and now_ms() - asked < LOGIN_WINDOW_MS), "canLogIn": bool(IBEAM_URL)}


def error_text(e: Exception) -> str:
    """A timeout or a dropped connection can come with no message: name its kind then."""
    return (str(e) or type(e).__name__)[:150]


def connect(make: Callable):
    """Opens a gateway connection, trying again a few seconds later when the
    gateway doesn't answer or hangs up. Raises the last error."""
    for attempt in range(CONNECT_TRIES):
        try:
            return make()
        except Exception as e:  # noqa: BLE001
            if attempt == CONNECT_TRIES - 1:
                raise
            if isinstance(e, LoggedOut):
                raise
            logger.info("IBKR's Web API didn't answer (%s); trying again", error_text(e))
            time.sleep(CONNECT_RETRY_S)


def settings_of(profile: Optional[dict]) -> dict:
    s = ((profile or {}).get("settings") or {})
    return {
        "mode": s.get("ibkrMode") if s.get("ibkrMode") in MODES else "off",
        "budget": s.get("ibkrBudget", 1000),
        "maxTrade": s.get("ibkrMaxTrade", 250),
        "dailyLoss": s.get("ibkrDailyLoss", 50),
    }


def now_ms() -> int:
    return int(time.time() * 1000)


def _box(state: dict) -> dict:
    return state.setdefault("ibkr", {"positions": {}, "orders": [], "account": None, "accountAt": None, "error": None})


def queue_events(state: dict, events: List[dict]) -> None:
    """Called as the paper account saves: its stock buys and sells wait here for
    process(). While IBKR is off no buys are queued, but the sale of anything
    really bought still is."""
    off = settings_of(state.get("profile"))["mode"] == "off"
    held = ((state.get("ibkr") or {}).get("positions") or {})
    stocks = [e for e in events if str(e.get("key", "")).startswith("stock:")
              and ((e.get("kind") == "open" and not off) or (e.get("kind") == "close" and (not off or e.get("key") in held)))]
    if stocks:
        state.setdefault("ibkrQueue", []).extend(stocks)


def _today(at: int, tz: ZoneInfo) -> str:
    return datetime.fromtimestamp(at / 1000, tz).strftime("%Y-%m-%d")


def loss_today(box: dict, tz: ZoneInfo, now: int) -> float:
    """Losses (as a positive number) from sales made today."""
    day = _today(now, tz)
    pnl = sum(o.get("pnl") or 0 for o in box.get("orders", [])
              if o.get("side") == "sell" and o.get("status") == "filled" and _today(o["at"], tz) == day)
    return max(0.0, -pnl)


def paper_equity(state: dict) -> Optional[float]:
    hist = ((state.get("paper") or {}).get("history") or [])
    eq = hist[-1].get("equity") if hist else (state.get("paper") or {}).get("start")
    return eq if isinstance(eq, (int, float)) and eq > 0 else None


def size_buy(ev: dict, cfg: dict, box: dict, equity: Optional[float], cash: Optional[float]) -> float:
    """USD for a real buy: the paper trade's share of the paper account, applied
    to your budget, within the per-trade limit, what is left of the budget and
    the cash IBKR says is available."""
    share = (ev.get("cost") or 0) / equity if equity else 0
    spent = sum(p.get("usd") or 0 for p in box.get("positions", {}).values())
    usd = min(share * cfg["budget"], cfg["maxTrade"], cfg["budget"] - spent)
    if cash is not None:
        usd = min(usd, cash)
    return round(max(0.0, usd), 2)


def _record(box: dict, order: dict) -> None:
    box["orders"] = ([order] + box.get("orders", []))[:KEEP_ORDERS]


def handle(ev: dict, cfg: dict, box: dict, gw, equity: Optional[float], tz: ZoneInfo, now: int) -> Optional[dict]:
    """Places the IBKR order for one paper buy or sell. Returns the order
    record, or None when nothing applies."""
    key, symbol = ev["key"], ev["symbol"]
    base = {"at": now, "key": key, "symbol": symbol, "mode": cfg["mode"]}
    if ev["kind"] == "open":
        if cfg["mode"] == "off" or key in box["positions"]:
            return None
        if cfg["dailyLoss"] > 0 and loss_today(box, tz, now) >= cfg["dailyLoss"]:
            return {**base, "side": "buy", "status": "skipped", "error": "today's loss limit is reached; buys resume tomorrow"}
        price = ev.get("price") or 0
        acct = box.get("account") or {}
        cash = acct.get("available") if acct.get("currency") == "USD" else None
        usd = size_buy(ev, cfg, box, equity, cash)
        if usd < MIN_ORDER_USD or price <= 0:
            return {**base, "side": "buy", "status": "skipped", "usd": usd, "error": "under the $10 minimum, or the budget is used up"}
        # Sent as a dollar amount: IBKR buys the fraction of a share it pays for.
        r = gw.order(symbol, "buy", usd=usd)
        if r["status"] == "failed":
            return {**base, "side": "buy", "status": "failed", "usd": usd, "error": r.get("error"), "id": r.get("id")}
        fill = r.get("price") or price
        # Until a waiting order fills, the shares are the paper price's estimate; settle_working corrects them.
        got = r.get("filled") if r["status"] == "filled" and r.get("filled") else round(usd / fill, QTY_DECIMALS)
        fee = r.get("fee") if r.get("fee") is not None else fee_estimate(got, fill)
        box["positions"][key] = {"symbol": symbol, "qty": got, "usd": round(got * fill + fee, 2),
                                 "at": now, "mode": cfg["mode"], "id": r.get("id"), "status": r["status"]}
        return {**base, "side": "buy", "status": r["status"], "usd": round(got * fill, 2), "qty": got,
                "price": fill, "fee": round(fee, 2), "id": r.get("id")}
    # A paper sale sells what was really bought for it.
    pos = box["positions"].get(key)
    if not pos:
        return None
    held = gw.positions().get(symbol) or 0
    qty = round(min(pos["qty"], held), QTY_DECIMALS)
    if qty <= 0:
        # Never sell what isn't held: on a margin account that would open a short.
        box["positions"].pop(key, None)
        return {**base, "mode": pos.get("mode"), "side": "sell", "status": "skipped", "error": "IBKR holds none of it (the buy may not have filled)"}
    r = gw.order(symbol, "sell", qty=qty)
    if r["status"] == "failed":
        return {**base, "mode": pos.get("mode"), "side": "sell", "status": "failed", "qty": qty, "error": r.get("error"), "id": r.get("id")}
    fill = r.get("price") or ev.get("price") or 0
    fee = r.get("fee") if r.get("fee") is not None else fee_estimate(qty, fill)
    box["positions"].pop(key, None)
    share = qty / pos["qty"] if pos["qty"] else 1
    return {**base, "mode": pos.get("mode"), "side": "sell", "status": r["status"], "usd": round(qty * fill, 2), "qty": qty, "price": fill,
            "fee": round(fee, 2), "pnl": round(qty * fill - fee - pos["usd"] * share, 2), "reason": ev.get("reason"), "id": r.get("id")}


def refresh_account(box: dict, gw, now: int) -> None:
    box["account"] = {"id": gw.account, "paper": str(gw.account).startswith("D"), **gw.funds()}
    box["accountAt"] = now


def _failed(ev: dict, mode: str, error: str) -> dict:
    return {"at": now_ms(), "key": ev["key"], "symbol": ev["symbol"], "side": "buy" if ev["kind"] == "open" else "sell",
            "mode": mode, "status": "failed", "error": error}


def process(load_state: Callable[[], dict], update_state: Callable, tz: ZoneInfo, make: Optional[Callable] = None) -> List[dict]:
    """Takes the queued paper buys and sells and places their IBKR orders, one
    at a time. A failed order is recorded and not retried."""
    if not _take("placing orders"):
        return []
    try:
        taken: List[dict] = []
        update_state(lambda st: (taken.extend(st.get("ibkrQueue") or []), st.update(ibkrQueue=[])))
        if not taken:
            return []
        state = load_state()
        cfg = settings_of(state.get("profile"))
        box = _box(state)
        records: List[dict] = []
        gw = None
        if not configured():
            records = [_failed(e, cfg["mode"], "IBKR's Web API is not set up on the server (IBKR_WEB_URL)") for e in taken]
        else:
            try:
                gw = connect(make or Gateway)
                refresh_account(box, gw, now_ms())
            except LoggedOut:
                gw = None
                records = [_failed(ev, cfg["mode"], "IBKR was logged out; log in from Settings") for ev in taken]
            except Exception as e:  # noqa: BLE001 - gateway down: each order is recorded as failed
                logger.warning("IBKR's Web API unreachable: %s", error_text(e))
                if gw is not None:
                    gw.close()
                gw = None
                records = [_failed(ev, cfg["mode"], f"IBKR's Web API unreachable after {CONNECT_TRIES} tries: {error_text(e)}") for ev in taken]
        if gw is not None and not box["account"]["paper"]:
            records = [_failed(ev, cfg["mode"], f"IBKR is logged in to live account {box['account']['id']}; only a paper account is traded for now") for ev in taken]
            gw.close()
            gw = None
        if gw is not None:
            try:
                equity = paper_equity(state)
                for ev in taken:
                    try:
                        rec = handle(ev, cfg, box, gw, equity, tz, now_ms())
                    except Exception as e:  # noqa: BLE001
                        logger.exception("IBKR order failed")
                        rec = _failed(ev, cfg["mode"], str(e)[:200])
                    if rec:
                        records.append(rec)
                if any(r.get("status") in ("filled", "working") for r in records):
                    try:
                        refresh_account(box, gw, now_ms())
                    except Exception:  # noqa: BLE001
                        pass
            finally:
                gw.close()

        def save(st):
            b = _box(st)
            b["positions"] = box.get("positions", {})
            b["account"], b["accountAt"] = box.get("account"), box.get("accountAt")
            for r in reversed(records):
                _record(b, r)
        update_state(save)
        return records
    finally:
        _give()


def settle_working(box: dict, gw) -> bool:
    """Orders that waited for the market to open: once IBKR no longer lists
    them as open, they have filled. Returns whether anything changed."""
    waiting = [o for o in box.get("orders", []) if o.get("status") == "working"]
    if not waiting:
        return False
    still = gw.working()
    held = gw.positions()
    changed = False
    for o in waiting:
        if o.get("id") in still:
            continue
        o["status"] = "filled" if o["side"] == "sell" or held.get(o["symbol"]) else "failed"
        if o["status"] == "failed":
            o["error"] = "IBKR cancelled it before the open"
            box.get("positions", {}).pop(o["key"], None)
        pos = box.get("positions", {}).get(o["key"])
        if pos and pos.get("id") == o.get("id"):
            pos["status"] = o["status"]
            if o["side"] == "buy" and o["status"] == "filled":
                pos["qty"] = o["qty"] = round(held[o["symbol"]], QTY_DECIMALS)   # what the dollar amount really bought
        changed = True
    return changed


def summary(state: dict, update_state: Callable, make: Optional[Callable] = None) -> dict:
    """What the app's Settings shows: whether the gateway answers, the account
    it is logged in to, its cash, the positions and the latest orders. IBKR is
    asked at most once a minute."""
    box = dict(state.get("ibkr") or {})
    error = None
    due = configured() and now_ms() - (box.get("accountAt") or 0) >= ACCOUNT_EVERY_MS
    if due and not _take("checking the account"):
        # Another IBKR job is running; only if it has run for minutes is something wrong.
        since = _busy.get("since")
        if since and now_ms() - since >= STUCK_MS:
            error = f"the server has been {_busy.get('what') or 'busy'} with IBKR for {(now_ms() - since) // 60_000} min without an answer"
        due = False
    if due:
        gw = None
        try:
            gw = (make or Gateway)()
            b = {"orders": [dict(o) for o in box.get("orders", [])], "positions": {k: dict(v) for k, v in (box.get("positions") or {}).items()}}
            refresh_account(b, gw, now_ms())
            settled = settle_working(b, gw)
            box.update(b, loggedOut=False)

            def save(st):
                s = _box(st)
                s["account"], s["accountAt"], s["loggedOut"] = b["account"], b["accountAt"], False
                if settled:
                    s["orders"], s["positions"] = b["orders"], b["positions"]
            update_state(save)
        except LoggedOut:
            box["loggedOut"] = True
            update_state(lambda st: _box(st).update(loggedOut=True))
        except Exception as e:  # noqa: BLE001
            error = error_text(e)
        finally:
            if gw is not None:
                gw.close()
            _give()
    cfg = settings_of(state.get("profile"))
    return {
        "configured": configured(),
        "mode": cfg["mode"],
        "account": box.get("account"),
        "accountAt": box.get("accountAt"),
        "error": error,
        "loggedOut": bool(box.get("loggedOut")),
        "login": login_info(),
        "positions": box.get("positions") or {},
        "orders": (box.get("orders") or [])[:30],
        "lossToday": round(loss_today(box, ZoneInfo(os.environ.get("TRADE_TZ", "America/Toronto")), now_ms()), 2),
    }
