"""
Stock orders on Interactive Brokers that follow the paper account.

When the paper account buys or sells a stock, the same trade is placed on
IBKR through IB Gateway (a second container on the VM that stays logged in),
sized from your budget in US dollars, in whole shares. For now only a paper
IBKR account is traded: "Paper" in the app's Settings refuses to send orders
if the gateway is logged in to a live account (live accounts start with U,
paper ones with D). Stops and targets stay with the app's paper account: when
it sells, the shares are sold at market.

Environment variables for this service (the IBKR username and password go to
the gateway container, not here; see docker-compose.snippet.yml):
    IBKR_HOST      - the gateway's name on the Docker network, e.g. ib-gateway (unset: IBKR off)
    IBKR_PORT      - its API port: 4004 for paper (4003 for live)
    IBKR_CLIENT_ID - any number no other program uses on the gateway (default 17);
                     Settings' check uses it and orders use the next number

Saved state, under state["ibkr"]:
    positions - key -> what was really bought: { symbol, qty, usd, at, mode, id, status }
    orders    - the latest orders, newest first: { at, key, symbol, side, mode, status, usd, qty, price, fee, pnl, error, id }
    account   - { id, paper, currency, available, net } at the last check
"""
import asyncio
import logging
import math
import os
import threading
import time
from datetime import datetime
from typing import Callable, Dict, List, Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger("trade-service")

HOST = os.environ.get("IBKR_HOST", "")
PORT = int(os.environ.get("IBKR_PORT", "4004") or 4004)
CLIENT_ID = int(os.environ.get("IBKR_CLIENT_ID", "17") or 17)
ORDER_CLIENT_ID = CLIENT_ID + 1   # orders never wait on Settings' check closing its connection
CONNECT_TRIES = 3
CONNECT_RETRY_S = 5       # the gateway can hang up on a connection (it did once at the market open)
MIN_ORDER_USD = 10
FILL_WAIT_S = 20          # a market order outside market hours waits for the open ("working")
ACCOUNT_EVERY_MS = 60_000
KEEP_ORDERS = 100
MODES = ("off", "paper")

_lock = threading.Lock()


def configured() -> bool:
    return bool(HOST)


def ib_symbol(symbol: str) -> str:
    """IBKR writes class shares with a space: BRK.B is "BRK B"."""
    return symbol.replace(".", " ").replace("-", " ")


def fee_estimate(qty: float, price: float) -> float:
    """IBKR Pro Fixed: $0.005 a share, at least $1, at most 1% of the trade."""
    value = qty * price
    return round(min(max(0.005 * qty, 1.0), 0.01 * value), 2) if value > 0 else 0.0


class Gateway:
    """The few IB Gateway calls the app needs, through ib_async. Tests use a
    fake with the same methods."""

    def __init__(self, client_id: int = CLIENT_ID):
        from ib_async import IB
        # ib_async runs on asyncio; each connection gets its own loop, closed with it.
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.ib = IB()
        try:
            self.ib.connect(HOST, PORT, clientId=client_id, timeout=15)
            accounts = self.ib.managedAccounts()
            if not accounts:
                raise RuntimeError("IB Gateway is not logged in to an account")
        except Exception:
            self.close()
            raise
        self.account = accounts[0]

    def close(self) -> None:
        try:
            self.ib.disconnect()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.loop.close()
        except Exception:  # noqa: BLE001
            pass

    def funds(self) -> dict:
        values = {v.tag: v for v in self.ib.accountSummary(self.account)}
        avail, net = values.get("AvailableFunds"), values.get("NetLiquidation")
        num = lambda v: float(v.value) if v is not None and v.value not in ("", None) else None  # noqa: E731
        return {"currency": (avail or net).currency if (avail or net) else None, "available": num(avail), "net": num(net)}

    def positions(self) -> Dict[str, float]:
        out: Dict[str, float] = {}
        for p in self.ib.positions(self.account):
            if p.contract.secType == "STK" and p.position:
                out[p.contract.symbol.replace(" ", ".")] = float(p.position)
        return out

    def order(self, symbol: str, side: str, qty: int) -> dict:
        from ib_async import MarketOrder, Stock
        contract = Stock(ib_symbol(symbol), "SMART", "USD")
        if not self.ib.qualifyContracts(contract):
            raise RuntimeError(f"IBKR doesn't know {symbol}")
        trade = self.ib.placeOrder(contract, MarketOrder(side.upper(), qty))
        waited = 0.0
        while not trade.isDone() and waited < FILL_WAIT_S:
            self.ib.sleep(0.5)
            waited += 0.5
        st = trade.orderStatus
        fee = sum((f.commissionReport.commission or 0) for f in trade.fills if f.commissionReport) or None
        oid = trade.order.permId or trade.order.orderId
        if st.status == "Filled":
            return {"status": "filled", "filled": float(st.filled), "price": float(st.avgFillPrice), "fee": fee, "id": oid}
        if trade.isDone():
            why = next((e.message for e in reversed(trade.log) if e.message), st.status)
            return {"status": "failed", "error": f"IBKR: {why}"[:200], "id": oid}
        # Market closed: the order waits for the open.
        return {"status": "working", "filled": float(st.filled or 0), "price": float(st.avgFillPrice or 0), "id": oid}

    def working(self) -> set:
        return {t.order.permId or t.order.orderId for t in self.ib.openTrades()}


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
            logger.info("IB Gateway didn't connect (%s); trying again", error_text(e))
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
        qty = math.floor(usd / price) if price > 0 else 0
        # Under one share: buy one, if it fits the per-trade limit, what is left of the budget and the cash.
        room = min(cfg["maxTrade"], cfg["budget"] - sum(p.get("usd") or 0 for p in box.get("positions", {}).values()),
                   cash if cash is not None else math.inf)
        if qty < 1 and 0 < price <= room:
            qty, usd = 1, round(price, 2)
        if qty < 1 or qty * price < MIN_ORDER_USD:
            why = ("under the $10 minimum" if qty >= 1 else f"one share (${price:,.2f}) costs more than the ${cfg['maxTrade']:,.0f} per-trade limit"
                   if price > cfg["maxTrade"] else f"one share (${price:,.2f}) costs more than what is left of the budget or cash (${max(0, room):,.2f})")
            return {**base, "side": "buy", "status": "skipped", "usd": usd, "error": why}
        r = gw.order(symbol, "buy", qty)
        if r["status"] == "failed":
            return {**base, "side": "buy", "status": "failed", "qty": qty, "error": r.get("error"), "id": r.get("id")}
        fill = r.get("price") or price
        got = r.get("filled") or qty
        fee = r.get("fee") if r.get("fee") is not None else fee_estimate(got, fill)
        box["positions"][key] = {"symbol": symbol, "qty": got if r["status"] == "filled" else qty, "usd": round(got * fill + fee, 2),
                                 "at": now, "mode": cfg["mode"], "id": r.get("id"), "status": r["status"]}
        return {**base, "side": "buy", "status": r["status"], "usd": round(qty * fill, 2), "qty": got if r["status"] == "filled" else qty,
                "price": fill, "fee": round(fee, 2), "id": r.get("id")}
    # A paper sale sells what was really bought for it.
    pos = box["positions"].get(key)
    if not pos:
        return None
    held = gw.positions().get(symbol) or 0
    qty = int(min(pos["qty"], held))
    if qty < 1:
        # Never sell what isn't held: on a margin account that would open a short.
        box["positions"].pop(key, None)
        return {**base, "mode": pos.get("mode"), "side": "sell", "status": "skipped", "error": "IBKR holds none of it (the buy may not have filled)"}
    r = gw.order(symbol, "sell", qty)
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
    if not _lock.acquire(blocking=False):
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
            records = [_failed(e, cfg["mode"], "IB Gateway is not set up on the server (IBKR_HOST)") for e in taken]
        else:
            try:
                gw = connect(make or (lambda: Gateway(ORDER_CLIENT_ID)))
                refresh_account(box, gw, now_ms())
            except Exception as e:  # noqa: BLE001 - gateway down or logged out: each order is recorded as failed
                logger.warning("IB Gateway unreachable: %s", error_text(e))
                if gw is not None:
                    gw.close()
                gw = None
                records = [_failed(ev, cfg["mode"], f"IB Gateway unreachable after {CONNECT_TRIES} tries: {error_text(e)}") for ev in taken]
        if gw is not None and not box["account"]["paper"]:
            records = [_failed(ev, cfg["mode"], f"the gateway is logged in to live account {box['account']['id']}; only a paper account is traded for now") for ev in taken]
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
        _lock.release()


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
        changed = True
    return changed


def summary(state: dict, update_state: Callable, make: Optional[Callable] = None) -> dict:
    """What the app's Settings shows: whether the gateway answers, the account
    it is logged in to, its cash, the positions and the latest orders. IBKR is
    asked at most once a minute."""
    box = dict(state.get("ibkr") or {})
    error = None
    if configured() and now_ms() - (box.get("accountAt") or 0) >= ACCOUNT_EVERY_MS and _lock.acquire(blocking=False):
        gw = None
        try:
            gw = (make or Gateway)()
            b = {"orders": [dict(o) for o in box.get("orders", [])], "positions": {k: dict(v) for k, v in (box.get("positions") or {}).items()}}
            refresh_account(b, gw, now_ms())
            settled = settle_working(b, gw)
            box.update(b)

            def save(st):
                s = _box(st)
                s["account"], s["accountAt"] = b["account"], b["accountAt"]
                if settled:
                    s["orders"], s["positions"] = b["orders"], b["positions"]
            update_state(save)
        except Exception as e:  # noqa: BLE001
            error = error_text(e)
        finally:
            if gw is not None:
                gw.close()
            _lock.release()
    cfg = settings_of(state.get("profile"))
    return {
        "configured": configured(),
        "mode": cfg["mode"],
        "account": box.get("account"),
        "accountAt": box.get("accountAt"),
        "error": error,
        "positions": box.get("positions") or {},
        "orders": (box.get("orders") or [])[:30],
        "lossToday": round(loss_today(box, ZoneInfo(os.environ.get("TRADE_TZ", "America/Toronto")), now_ms()), 2),
    }
