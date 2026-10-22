"""
Real crypto orders on NDAX that follow the paper account.

When the paper account buys or sells a coin, the same trade is placed on NDAX
in Canadian dollars, sized from your real-money budget. Nothing is sent unless
you pick "Live" in the app's Settings; "Dry run" records the exact orders it
would place without sending them. Stops and targets stay with the paper
account: when it sells, the real coins are sold at market.

Environment variables (from NDAX: Settings, API Key; the user ID is under
Personal User Info). Give the key trading permission only, never withdrawals.
    NDAX_API_KEY, NDAX_API_SECRET, NDAX_USER_ID

Saved state, under state["ndax"]:
    coins      - coins NDAX sells for CAD, refreshed daily (public, no key needed)
    positions  - key -> what was really bought: { symbol, qty, cad, at, mode }
    orders     - the latest orders, newest first: { at, key, symbol, side, mode, status, cad, qty, price, fee, pnl, error }
    balance    - { CAD: free cash, ... } at the last check
"""
import logging
import os
import threading
import time
from datetime import datetime
from typing import Callable, Dict, List, Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger("trade-service")

API_KEY = os.environ.get("NDAX_API_KEY", "")
API_SECRET = os.environ.get("NDAX_API_SECRET", "")
USER_ID = os.environ.get("NDAX_USER_ID", "")
QUOTE = "CAD"
MIN_ORDER_CAD = 10        # smaller orders are skipped; NDAX's own minimums are checked too
COINS_EVERY_MS = 24 * 3600_000
BALANCE_EVERY_MS = 60_000
KEEP_ORDERS = 100
MODES = ("off", "dry", "live")

_lock = threading.Lock()


def configured() -> bool:
    return bool(API_KEY and API_SECRET and USER_ID)


def exchange(private: bool = True):
    """A ccxt NDAX client. With the key it signs each request (key, secret and
    user ID); ccxt's other sign-in, by login and password, is not used."""
    import ccxt
    ex = ccxt.ndax({"apiKey": API_KEY, "secret": API_SECRET, "uid": USER_ID, "enableRateLimit": True} if private else {"enableRateLimit": True})
    ex.requiredCredentials = {**ex.requiredCredentials, "login": False, "password": False}
    return ex


def settings_of(profile: Optional[dict]) -> dict:
    s = ((profile or {}).get("settings") or {})
    return {
        "mode": s.get("ndaxMode") if s.get("ndaxMode") in MODES else "off",
        "budget": s.get("ndaxBudget", 100),
        "maxTrade": s.get("ndaxMaxTrade", 25),
        "dailyLoss": s.get("ndaxDailyLoss", 20),
    }


def now_ms() -> int:
    return int(time.time() * 1000)


def _box(state: dict) -> dict:
    return state.setdefault("ndax", {"coins": None, "coinsAt": None, "positions": {}, "orders": [], "balance": None, "balanceAt": None, "error": None})


def tradable(state: dict) -> Optional[List[str]]:
    """The coins the paper account may buy: those NDAX sells for CAD, or None
    (any coin) before the list has loaded."""
    coins = (state.get("ndax") or {}).get("coins")
    return list(coins) if coins else None


def coins_due(state: dict, now: int) -> bool:
    box = state.get("ndax") or {}
    return now - (box.get("coinsAt") or 0) >= COINS_EVERY_MS


def load_coins(ex) -> List[str]:
    markets = ex.load_markets()
    return sorted({m["base"] for m in markets.values() if m.get("quote") == QUOTE and m.get("active") is not False})


def queue_events(state: dict, events: List[dict]) -> None:
    """Called as the paper account saves: its crypto buys and sells wait here
    for process(). While real trading is off no buys are queued, but the sale
    of anything really bought still is."""
    off = settings_of(state.get("profile"))["mode"] == "off"
    held = ((state.get("ndax") or {}).get("positions") or {})
    crypto = [e for e in events if str(e.get("key", "")).startswith("crypto:")
              and ((e.get("kind") == "open" and not off) or (e.get("kind") == "close" and (not off or e.get("key") in held)))]
    if crypto:
        state.setdefault("ndaxQueue", []).extend(crypto)


def _today(at: int, tz: ZoneInfo) -> str:
    return datetime.fromtimestamp(at / 1000, tz).strftime("%Y-%m-%d")


def loss_today(box: dict, tz: ZoneInfo, now: int) -> float:
    """Live losses (as a positive number) from sales made today."""
    day = _today(now, tz)
    pnl = sum(o.get("pnl") or 0 for o in box.get("orders", [])
              if o.get("side") == "sell" and o.get("mode") == "live" and o.get("status") == "filled" and _today(o["at"], tz) == day)
    return max(0.0, -pnl)


def paper_equity(state: dict) -> Optional[float]:
    hist = ((state.get("paper") or {}).get("history") or [])
    eq = hist[-1].get("equity") if hist else (state.get("paper") or {}).get("start")
    return eq if isinstance(eq, (int, float)) and eq > 0 else None


def size_buy(ev: dict, cfg: dict, box: dict, equity: Optional[float], cash: Optional[float]) -> float:
    """CAD for a real buy: the paper trade's share of the paper account, applied
    to your budget, within the per-trade limit, what is left of the budget and
    the CAD cash on NDAX."""
    share = (ev.get("cost") or 0) / equity if equity else 0
    spent = sum(p.get("cad") or 0 for p in box.get("positions", {}).values() if p.get("mode") == cfg["mode"])
    cad = min(share * cfg["budget"], cfg["maxTrade"], cfg["budget"] - spent)
    if cash is not None:
        cad = min(cad, cash * 0.995)  # room for the fee
    return round(max(0.0, cad), 2)


def _fee_cad(order: dict, price: float) -> Optional[float]:
    fee = order.get("fee") or {}
    cost = fee.get("cost")
    if not isinstance(cost, (int, float)):
        return None
    return cost if fee.get("currency") in (None, QUOTE) else cost * price


def _record(box: dict, order: dict) -> None:
    box["orders"] = ([order] + box.get("orders", []))[:KEEP_ORDERS]


def handle(ev: dict, cfg: dict, box: dict, ex, equity: Optional[float], tz: ZoneInfo, now: int) -> Optional[dict]:
    """Places (or, in a dry run, records) the real order for one paper buy or
    sell. Returns the order record, or None when nothing applies."""
    key, symbol = ev["key"], ev["symbol"]
    pair = f"{symbol}/{QUOTE}"
    base = {"at": now, "key": key, "symbol": symbol, "mode": cfg["mode"]}
    if ev["kind"] == "open":
        if cfg["mode"] == "off" or key in box["positions"]:
            return None
        if cfg["mode"] == "live" and cfg["dailyLoss"] > 0 and loss_today(box, tz, now) >= cfg["dailyLoss"]:
            return {**base, "side": "buy", "status": "skipped", "error": "today's loss limit is reached; buys resume tomorrow"}
        if pair not in ex.markets:
            return {**base, "side": "buy", "status": "skipped", "error": "NDAX does not sell this coin for CAD"}
        cash = None
        if cfg["mode"] == "live":
            cash = (box.get("balance") or {}).get(QUOTE)
        cad = size_buy(ev, cfg, box, equity, cash)
        market = ex.markets[pair]
        ticker = ex.fetch_ticker(pair)
        price = ticker.get("ask") or ticker.get("last")
        if not price:
            return {**base, "side": "buy", "status": "failed", "error": "no NDAX price"}
        qty = float(ex.amount_to_precision(pair, cad / price)) if cad > 0 else 0
        least = max(MIN_ORDER_CAD, ((market.get("limits") or {}).get("cost") or {}).get("min") or 0)
        least_qty = ((market.get("limits") or {}).get("amount") or {}).get("min") or 0
        if cad < least or qty <= 0 or qty < least_qty:
            return {**base, "side": "buy", "status": "skipped", "cad": cad, "error": f"under NDAX's or the app's minimum order (${least:.0f} CAD), or the budget is used up"}
        if cfg["mode"] == "dry":
            box["positions"][key] = {"symbol": symbol, "qty": qty, "cad": round(qty * price * 1.002, 2), "at": now, "mode": "dry"}
            return {**base, "side": "buy", "status": "dry", "cad": round(qty * price, 2), "qty": qty, "price": price, "fee": round(qty * price * 0.002, 2)}
        order = ex.create_order(pair, "market", "buy", qty)
        filled = order.get("filled") or qty
        avg = order.get("average") or price
        fee = _fee_cad(order, avg)
        cost = filled * avg + (fee or 0)
        box["positions"][key] = {"symbol": symbol, "qty": filled, "cad": round(cost, 2), "at": now, "mode": "live", "id": order.get("id")}
        return {**base, "side": "buy", "status": "filled", "cad": round(filled * avg, 2), "qty": filled, "price": avg, "fee": None if fee is None else round(fee, 2), "id": order.get("id")}
    # A paper sale sells what was really bought for it, in the mode it was bought.
    pos = box["positions"].get(key)
    if not pos:
        return None
    ticker = ex.fetch_ticker(pair)
    price = ticker.get("bid") or ticker.get("last") or 0
    if pos.get("mode") != "live":
        box["positions"].pop(key, None)
        back = pos["qty"] * price * 0.998
        return {**base, "mode": "dry", "side": "sell", "status": "dry", "cad": round(pos["qty"] * price, 2), "qty": pos["qty"], "price": price,
                "fee": round(pos["qty"] * price * 0.002, 2), "pnl": round(back - pos["cad"], 2), "reason": ev.get("reason")}
    free = ((box.get("balance") or {}).get(symbol))
    qty = min(pos["qty"], free) if isinstance(free, (int, float)) and free > 0 else pos["qty"]
    qty = float(ex.amount_to_precision(pair, qty))
    order = ex.create_order(pair, "market", "sell", qty)
    filled = order.get("filled") or qty
    avg = order.get("average") or price
    fee = _fee_cad(order, avg)
    back = filled * avg - (fee or 0)
    box["positions"].pop(key, None)
    return {**base, "mode": "live", "side": "sell", "status": "filled", "cad": round(filled * avg, 2), "qty": filled, "price": avg,
            "fee": None if fee is None else round(fee, 2), "pnl": round(back - pos["cad"], 2), "reason": ev.get("reason"), "id": order.get("id")}


def refresh_balance(box: dict, ex, now: int) -> None:
    bal = ex.fetch_balance()
    box["balance"] = {c: v for c, v in (bal.get("free") or {}).items() if isinstance(v, (int, float)) and v > 0}
    box["balanceAt"] = now


def process(load_state: Callable[[], dict], update_state: Callable, tz: ZoneInfo, make: Callable = exchange) -> List[dict]:
    """Takes the queued paper buys and sells and places their real orders, one
    at a time. A failed order is recorded and not retried."""
    if not _lock.acquire(blocking=False):
        return []
    try:
        taken: List[dict] = []
        update_state(lambda st: (taken.extend(st.get("ndaxQueue") or []), st.update(ndaxQueue=[])))
        if not taken:
            return []
        state = load_state()
        cfg = settings_of(state.get("profile"))
        box = _box(state)
        records: List[dict] = []
        ex = None
        live = cfg["mode"] == "live" or any((box["positions"].get(e["key"]) or {}).get("mode") == "live" for e in taken)
        if live and not configured():
            records = [{"at": now_ms(), "key": e["key"], "symbol": e["symbol"], "side": "buy" if e["kind"] == "open" else "sell", "mode": "live",
                        "status": "failed", "error": "the NDAX key is not set on the server"} for e in taken]
        else:
            try:
                ex = make(live)
                ex.load_markets()
            except Exception as e:  # noqa: BLE001 - NDAX unreachable: each order is recorded as failed
                logger.warning("NDAX unreachable: %s", e)
                ex = None
                records = [{"at": now_ms(), "key": ev["key"], "symbol": ev["symbol"], "side": "buy" if ev["kind"] == "open" else "sell",
                            "mode": cfg["mode"], "status": "failed", "error": f"NDAX unreachable: {str(e)[:150]}"} for ev in taken]
        if not records and ex is not None:
            if live:
                try:
                    refresh_balance(box, ex, now_ms())
                except Exception as e:  # noqa: BLE001 - the order itself reports what went wrong
                    logger.warning("NDAX balance failed: %s", e)
            equity = paper_equity(state)
            for ev in taken:
                try:
                    rec = handle(ev, cfg, box, ex, equity, tz, now_ms())
                except Exception as e:  # noqa: BLE001
                    logger.exception("NDAX order failed")
                    rec = {"at": now_ms(), "key": ev["key"], "symbol": ev["symbol"], "side": "buy" if ev["kind"] == "open" else "sell",
                           "mode": cfg["mode"], "status": "failed", "error": str(e)[:200]}
                if rec:
                    records.append(rec)
            if live and any(r.get("status") == "filled" for r in records):
                try:
                    refresh_balance(box, ex, now_ms())
                except Exception:  # noqa: BLE001
                    pass

        def save(st):
            b = _box(st)
            b["positions"] = box.get("positions", {})
            b["balance"], b["balanceAt"] = box.get("balance"), box.get("balanceAt")
            for r in reversed(records):
                _record(b, r)
        update_state(save)
        return records
    finally:
        _lock.release()


def refresh_coins(update_state: Callable, make: Callable = exchange) -> Optional[List[str]]:
    """Daily: the coins NDAX sells for CAD. Public data, so it needs no key."""
    try:
        coins = load_coins(make(False))
    except Exception as e:  # noqa: BLE001
        logger.warning("NDAX coin list failed: %s", e)
        update_state(lambda st: _box(st).update(coinsAt=now_ms(), error=f"coin list: {str(e)[:150]}"))
        return None
    update_state(lambda st: _box(st).update(coins=coins, coinsAt=now_ms(), error=None))
    return coins


def summary(state: dict, update_state: Callable, make: Callable = exchange) -> dict:
    """What the app's Settings shows: whether the key is set, your NDAX cash,
    the real positions and the latest orders. The balance is re-read at most
    once a minute."""
    box = dict(state.get("ndax") or {})
    error = None
    if configured() and now_ms() - (box.get("balanceAt") or 0) >= BALANCE_EVERY_MS:
        try:
            b = {}
            refresh_balance(b, make(True), now_ms())
            box.update(b)
            update_state(lambda st: _box(st).update(balance=b["balance"], balanceAt=b["balanceAt"]))
        except Exception as e:  # noqa: BLE001
            error = str(e)[:200]
    cfg = settings_of(state.get("profile"))
    return {
        "configured": configured(),
        "mode": cfg["mode"],
        "balance": box.get("balance"),
        "balanceAt": box.get("balanceAt"),
        "balanceError": error,
        "coins": len(box.get("coins") or []),
        "coinsError": box.get("error"),
        "positions": box.get("positions") or {},
        "orders": (box.get("orders") or [])[:30],
        "lossToday": round(loss_today(box, ZoneInfo(os.environ.get("TRADE_TZ", "America/Toronto")), now_ms()), 2),
    }
