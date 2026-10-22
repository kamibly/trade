"""
Background work for trade-service: the saved state, the two scheduled checks,
and app notifications (Web Push).

The scoring itself happens in engine.mjs, which reuses the app's JavaScript so
the server and the phone agree on every score. This module runs it with Node.

Environment variables:
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT  - app notifications
    TRADE_TZ           - time zone for quiet hours and scan times, default America/Toronto
    CRYPTO_SCAN_MINUTES - how often the crypto scan runs, around the clock, default 15
    MARKET_SCAN_TIMES  - when the S&P 500 scan runs, default every 30 minutes while the
                         US market is open plus 20:00: "09:45,10:45,11:45,12:45,13:45,14:45,15:45,20:00"
    TWELVE_DATA_KEY    - optional; backup for stocks Yahoo Finance can't serve
    DATA_DIR           - where trade.json is kept, default /data
    TRAIN_AT           - when the machine-learning models retrain each week, default "Sun 03:00"
    TRAIN_SYMBOLS      - how many charts the models learn from, default 120
    SEC_CONTACT        - your email, which the SEC asks for in its requests; insider buying
                         and earnings dates load only once it is set (see events.py)
    NDAX_API_KEY, NDAX_API_SECRET, NDAX_USER_ID - real crypto orders on NDAX (see ndax.py)
"""
import json
import logging
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from typing import Callable, Dict, List, Optional
from zoneinfo import ZoneInfo

import ndax

logger = logging.getLogger("trade-service")

VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:you@example.com")
TZ_NAME = os.environ.get("TRADE_TZ", "America/Toronto")
DEFAULT_SCAN_TIMES = "09:45,10:15,10:45,11:15,11:45,12:15,12:45,13:15,13:45,14:15,14:45,15:15,15:45,20:00"
MARKET_SCAN_TIMES = os.environ.get("MARKET_SCAN_TIMES", DEFAULT_SCAN_TIMES)
TWELVE_DATA_KEY = os.environ.get("TWELVE_DATA_KEY", "")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
STATE_FILE = os.path.join(DATA_DIR, "trade.json")
ENGINE = os.environ.get("ENGINE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine.mjs"))
NODE = os.environ.get("NODE_BIN", "node")
ML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml.py")
TRAIN_AT = os.environ.get("TRAIN_AT", "Sun 03:00")
TRAIN_SYMBOLS = int(os.environ.get("TRAIN_SYMBOLS", "120") or 120)
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# How often the watchlist and holdings are checked, by alert timeframe (minutes),
# besides the check right after every candle closes.
WATCH_EVERY = {"15m": 5, "1h": 15, "1D": 15, "1W": 60}
TF_SECONDS = {"15m": 900, "1h": 3600, "1D": 86400, "1W": 604800}
CLOSE_DELAY_MS = 60_000      # give the data sources a minute to publish a closed candle
PRICES_EVERY_MS = 60_000     # stop-loss and target checks
NEW_YORK = ZoneInfo("America/New_York")
QUIET_START, QUIET_END = 22, 7
TIMEFRAMES = set(WATCH_EVERY)

_lock = threading.RLock()
_run_locks = {name: threading.Lock() for name in ("watch", "market", "crypto", "pulse", "train", "events")}
CRYPTO_SCAN_MINUTES = int(os.environ.get("CRYPTO_SCAN_MINUTES", "15") or 15)
UNIVERSE_EVERY_MS = 20 * 3600_000  # the crypto list is rebuilt about once a day
PULSE_EVERY_MS = 60_000            # fast-move watch
SP500_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sp500.csv")
SETUP_IDS = ("insider", "earnings", "ranking", "crowd")
EVENTS_EVERY_MS = 3600_000   # outside data for the setups (insiders, earnings, crowd)
MUTE_VOTES, MUTE_AT = 10, 7  # "Not useful" on 7 of the last 10 ratings mutes a setup's alerts


def tz() -> ZoneInfo:
    try:
        return ZoneInfo(TZ_NAME)
    except Exception:
        return ZoneInfo("America/Toronto")


def now_ms() -> int:
    return int(time.time() * 1000)


def push_enabled() -> bool:
    return bool(VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)


# ---------------------------------------------------------------------------
# State file
# ---------------------------------------------------------------------------

def _empty_state() -> dict:
    return {
        "profile": None,          # watchlist, holdings and settings from the app
        "subscriptions": [],      # devices that get notifications
        "signals": {},            # last watch signal per symbol
        "weights": {},            # learned method weights per symbol and timeframe
        "market": None,           # last market scan result
        "marketActions": {},      # last market scan action per symbol
        "marketWeights": {},
        "watch": {"lastRunAt": None, "errors": {}, "lastAlerts": []},
        "lastMarketSlot": None,
        "scans": {},              # the latest stock scan and crypto scan; "market" shows both
        "lastCryptoSlot": None,
        "cryptoUniverse": None,   # coins the crypto scan covers, rebuilt daily
        "cryptoLevels": {},       # each coin's price and ATR at its last scan, for the fast-move watch
        "pulse": {"lastRunAt": None},
        "training": {"lastRunAt": None, "results": {}},  # last model training per timeframe
        "lastTrainSlot": None,
        "paper": None,            # the paper-trading account (runs here, shown in the app)
        "paperEvents": [],        # its latest buys and sells
        "paperShadow": None,      # the same account without the trade filter, to judge the filter
        "filterTrial": None,      # how the filtered account does against the shadow
        "paperBudgets": None,     # each source's share of the account, following its results
        "marketMood": {},         # SPY's and Bitcoin's trend at the last scans, for the trade filter
        "prices": {"lastRunAt": None, "values": {}, "errors": {}},
        "watchSoonAt": None,      # a check asked for after a settings or watchlist change
        "events": {"lastRunAt": None},  # last refresh of the setups' outside data
        "announced": [],          # opportunity and warning ids already sent
        "feedback": {},           # setup -> your latest ratings, True for useful
    }


def load_state() -> dict:
    with _lock:
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            state = _empty_state()
            state.update(data if isinstance(data, dict) else {})
            return state
        except FileNotFoundError:
            return _empty_state()
        except Exception:
            logger.exception("Could not read %s, starting empty", STATE_FILE)
            return _empty_state()


def save_state(state: dict) -> None:
    with _lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(tmp, STATE_FILE)


def update_state(fn: Callable[[dict], None]) -> dict:
    with _lock:
        state = load_state()
        fn(state)
        save_state(state)
        return state


# ---------------------------------------------------------------------------
# Profile sync
# ---------------------------------------------------------------------------

def _num(value, default, lo, hi):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return min(hi, max(lo, v))


def clean_item(raw) -> Optional[dict]:
    if not isinstance(raw, dict) or raw.get("type") not in ("stock", "crypto"):
        return None
    symbol = str(raw.get("symbol", "")).upper()[:12]
    if not symbol or not all(c.isalnum() or c in ".-" for c in symbol):
        return None
    item = {"type": raw["type"], "symbol": symbol, "name": str(raw.get("name") or symbol)[:80]}
    if raw.get("geckoId"):
        item["geckoId"] = str(raw["geckoId"])[:80]
    return item


def clean_holding(raw) -> Optional[dict]:
    item = clean_item(raw)
    if not item:
        return None
    qty = _num(raw.get("qty"), 0, 0, 1e12)
    buy = _num(raw.get("buyPrice"), 0, 0, 1e12)
    if qty <= 0 or buy <= 0:
        return None
    stop = raw.get("stop")
    take = raw.get("take")
    return {
        **item,
        "id": str(raw.get("id") or f"{item['type']}:{item['symbol']}")[:80],
        "key": f"{item['type']}:{item['symbol']}",
        "qty": qty,
        "buyPrice": buy,
        "stop": _num(stop, None, 0, 1e12) if stop is not None else None,
        "take": _num(take, None, 0, 1e12) if take is not None else None,
        "alerted": raw.get("alerted") if isinstance(raw.get("alerted"), dict) else {},
    }


def clean_profile(raw: dict) -> dict:
    s = raw.get("settings") if isinstance(raw.get("settings"), dict) else {}
    buy = _num(s.get("buyAt"), 40, 10, 100)
    sell = _num(s.get("sellAt"), -40, -100, -10)
    tf = s.get("alertTf") if s.get("alertTf") in TIMEFRAMES else "1D"
    watchlist = [i for i in (clean_item(x) for x in (raw.get("watchlist") or [])[:200]) if i]
    holdings = [h for h in (clean_holding(x) for x in (raw.get("holdings") or [])[:200]) if h]
    return {
        "watchlist": watchlist,
        "holdings": holdings,
        "settings": {
            "alertTf": tf,
            "tune": "manual" if s.get("tune") == "manual" else "auto",
            "mode": "dip" if s.get("mode") == "dip" else "standard",
            "buyAt": buy,
            "sellAt": sell,
            "stopAtr": _num(s.get("stopAtr"), 2, 0.5, 10),
            "takeAtr": _num(s.get("takeAtr"), 3, 0.5, 20),
            "quietHours": bool(s.get("quietHours", True)),
            "riskPct": _num(s.get("riskPct"), 1, 0.1, 5),
            "paperStart": round(_num(s.get("paperStart"), 10000, 100, 10_000_000)),
            "tradeFilter": bool(s.get("tradeFilter", True)),
            "paperExit": s.get("paperExit") if s.get("paperExit") in ("trail", "lock") else "target",
            "ndaxMode": s.get("ndaxMode") if s.get("ndaxMode") in ndax.MODES else "off",
            "ndaxBudget": round(_num(s.get("ndaxBudget"), 100, 0, 1_000_000), 2),
            "ndaxMaxTrade": round(_num(s.get("ndaxMaxTrade"), 25, 0, 1_000_000), 2),
            "ndaxDailyLoss": round(_num(s.get("ndaxDailyLoss"), 20, 0, 1_000_000), 2),
            "setups": {k: bool((s.get("setups") or {}).get(k, True)) if isinstance(s.get("setups"), dict) else True for k in SETUP_IDS},
        },
        "updatedAt": int(_num(raw.get("updatedAt"), now_ms(), 0, 1e15)),
    }


WATCH_SOON_MS = 30_000  # after a change, wait for the phone's other edits before checking


def _signal_inputs(profile: Optional[dict]):
    """What a watch run's signals depend on: the symbols and the settings."""
    if not profile:
        return None
    keys = sorted(f"{i['type']}:{i['symbol']}" for i in profile["watchlist"] + profile["holdings"])
    return keys, {k: v for k, v in profile["settings"].items() if k != "quietHours"}


def set_profile(raw: dict) -> dict:
    profile = clean_profile(raw)

    def apply(state):
        # A new symbol or setting gets checked within a minute, not at the next scheduled run.
        if _signal_inputs(state.get("profile")) != _signal_inputs(profile):
            state["watchSoonAt"] = now_ms() + WATCH_SOON_MS
        # Alerts already sent for a holding stay sent, whichever side last saved it.
        old = {h["id"]: h.get("alerted", {}) for h in ((state.get("profile") or {}).get("holdings") or [])}
        for h in profile["holdings"]:
            if h["id"] in old:
                h["alerted"] = {**h["alerted"], **old[h["id"]]}
        state["profile"] = profile

    update_state(apply)
    return profile


# ---------------------------------------------------------------------------
# Subscriptions and Web Push
# ---------------------------------------------------------------------------

def add_subscription(sub: dict, label: str = "") -> int:
    if not isinstance(sub, dict) or not sub.get("endpoint") or not isinstance(sub.get("keys"), dict):
        raise ValueError("Invalid push subscription")
    entry = {
        "endpoint": str(sub["endpoint"]),
        "keys": {"p256dh": str(sub["keys"].get("p256dh", "")), "auth": str(sub["keys"].get("auth", ""))},
        "label": str(label or "")[:80],
        "addedAt": now_ms(),
    }

    def apply(state):
        state["subscriptions"] = [s for s in state["subscriptions"] if s.get("endpoint") != entry["endpoint"]]
        state["subscriptions"].append(entry)

    return len(update_state(apply)["subscriptions"])


def remove_subscription(endpoint: str) -> int:
    def apply(state):
        state["subscriptions"] = [s for s in state["subscriptions"] if s.get("endpoint") != endpoint]

    return len(update_state(apply)["subscriptions"])


def _send(sub: dict, payload: dict) -> bool:
    """Sends one notification. Returns False when the device is gone."""
    from pywebpush import WebPushException, webpush
    try:
        webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=6 * 3600,
        )
        return True
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        if status in (404, 410):
            return False
        logger.warning("Push failed (%s): %s", status, e)
        return True


def send_to_all(payload: dict, only: Optional[str] = None) -> int:
    if not push_enabled():
        return 0
    subs = [s for s in load_state()["subscriptions"] if only is None or s["endpoint"] == only]
    gone, sent = [], 0
    for sub in subs:
        if _send(sub, payload):
            sent += 1
        else:
            gone.append(sub["endpoint"])
    if gone:
        update_state(lambda st: st.update(subscriptions=[s for s in st["subscriptions"] if s["endpoint"] not in gone]))
    return sent


def in_quiet_hours(when: datetime) -> bool:
    return when.hour >= QUIET_START or when.hour < QUIET_END


def deliver(alerts: List[dict], quiet: bool, when: Optional[datetime] = None, muted: Optional[set] = None) -> int:
    """Sends alerts; during quiet hours only urgent ones (stop-loss hits).
    Alerts from setups you muted are skipped. Setup alerts carry the
    Useful and Not useful buttons."""
    when = when or datetime.now(tz())
    muted = muted or set()
    sent = 0
    for a in alerts:
        if quiet and in_quiet_hours(when) and not a.get("urgent"):
            continue
        setups = a.get("setups") or []
        if setups and all(x in muted for x in setups):
            continue
        payload = {"title": a["title"], "body": a["body"], "tag": f"{a.get('kind')}:{a.get('key', '')}", "hash": a.get("hash", "signals")}
        if setups:
            payload["feedback"] = {"setups": setups, "id": a.get("id") or ",".join(a.get("ids") or []) or payload["tag"]}
        sent += send_to_all(payload)
    return sent


# ---------------------------------------------------------------------------
# Your ratings of alerts
# ---------------------------------------------------------------------------

def muted_setups(state: dict) -> set:
    """Setups whose alerts you rated "Not useful" 7 or more times of the last 10."""
    out = set()
    for setup, votes in (state.get("feedback") or {}).items():
        last = votes[-MUTE_VOTES:]
        if sum(1 for v in last if not v) >= MUTE_AT:
            out.add(setup)
    return out


FEEDBACK_SETUPS = SETUP_IDS + ("signal",)


def add_feedback(setups: List[str], useful: bool) -> dict:
    setups = [x for x in dict.fromkeys(setups or []) if x in FEEDBACK_SETUPS]
    if not setups:
        raise ValueError("Unknown alert type")

    def apply(st):
        fb = st.setdefault("feedback", {})
        for x in setups:
            fb[x] = (fb.get(x, []) + [bool(useful)])[-MUTE_VOTES:]

    return setups_info(update_state(apply))


def unmute(setup: str) -> dict:
    """Turns a muted setup's alerts back on, starting its ratings over."""
    if setup not in FEEDBACK_SETUPS:
        raise ValueError("Unknown alert type")
    return setups_info(update_state(lambda st: st.setdefault("feedback", {}).pop(setup, None)))


def setups_info(state: dict) -> dict:
    """For the app: your ratings, what is muted and whether each data source loaded."""
    import events
    fb = state.get("feedback") or {}
    return {
        "votes": {k: {"useful": sum(1 for v in fb[k] if v), "notUseful": sum(1 for v in fb[k] if not v)} for k in fb},
        "muted": sorted(muted_setups(state)),
        "sources": events.statuses(events_dir()),
        "secContact": bool(events.SEC_CONTACT),
        "eventsAt": (state.get("events") or {}).get("lastRunAt"),
    }


def send_test(endpoint: Optional[str]) -> int:
    payload = {"title": "Trade alerts from your server are on", "body": "Buy, sell and stop-loss alerts will arrive here even when the app is closed.", "tag": "test", "hash": "signals"}
    return send_to_all(payload, only=endpoint)


# ---------------------------------------------------------------------------
# Running the engine
# ---------------------------------------------------------------------------

def run_engine(job: dict, timeout: int) -> dict:
    proc = subprocess.run([NODE, ENGINE], input=json.dumps(job), capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "engine failed").strip().splitlines()[-1][:300])
    return json.loads(proc.stdout)


def engine_settings(profile: dict) -> dict:
    s = profile["settings"]
    return {"tune": s["tune"], "mode": s["mode"], "buyAt": s["buyAt"], "sellAt": s["sellAt"], "stopAtr": s["stopAtr"], "takeAtr": s["takeAtr"], "twelveKey": TWELVE_DATA_KEY}


def watch_items(profile: dict) -> List[dict]:
    items, seen = [], set()
    for i in profile["watchlist"] + profile["holdings"]:
        k = f"{i['type']}:{i['symbol']}"
        if k not in seen:
            seen.add(k)
            items.append({x: i[x] for x in ("type", "symbol", "name", "geckoId") if x in i})
    return items


def run_watch(reason: str = "schedule", engine: Callable[[dict, int], dict] = run_engine) -> Optional[dict]:
    lock = _run_locks["watch"]
    if not lock.acquire(blocking=False):
        return None
    try:
        state = load_state()
        profile = state.get("profile")
        if not profile:
            return None
        started = now_ms()
        tf = profile["settings"]["alertTf"]
        items = watch_items(profile)
        keys = {f"{i['type']}:{i['symbol']}:{tf}" for i in items}
        job = {
            "mode": "watch",
            "tf": tf,
            "settings": engine_settings(profile),
            "items": items,
            "holdings": profile["holdings"],
            "prev": state["signals"],
            "weights": {k: v for k, v in state["weights"].items() if k in keys},
            "models": load_models(tf),
            "mood": state.get("marketMood") or {},
            "riskPct": profile["settings"].get("riskPct", 1),
            **paper_fields(state, profile),
        }
        try:
            result = engine(job, 600)
        except Exception as e:
            logger.exception("Watch run failed")
            def failed(st):
                st["watch"].update(lastRunAt=now_ms(), errors={"engine": str(e)})
                clear_watch_soon(st, started)
            update_state(failed)
            return None
        sent = deliver(result["alerts"], profile["settings"]["quietHours"], muted=muted_setups(state))

        def apply(st):
            st["signals"].update(result["signals"])
            st["weights"] = {**{k: v for k, v in st["weights"].items() if k in keys}, **result["weights"]}
            p = st.get("profile")
            if p:
                for h in p["holdings"]:
                    if h["id"] in result["holdingsAlerted"]:
                        h["alerted"] = result["holdingsAlerted"][h["id"]]
            st["watch"] = {
                "lastRunAt": now_ms(),
                "reason": reason,
                "errors": result["errors"],
                "lastAlerts": ([{"title": a["title"], "at": now_ms()} for a in result["alerts"]] + st["watch"].get("lastAlerts", []))[:20],
                "sent": sent,
            }
            save_paper(st, result)
            clear_watch_soon(st, started)

        update_state(apply)
        return result
    finally:
        lock.release()


def new_paper(profile: dict) -> dict:
    """A fresh paper account, the same shape as app/js/paper.js newAccount()."""
    start = (profile.get("settings") or {}).get("paperStart", 10000)
    now = now_ms()
    return {"start": start, "cash": start, "createdAt": now, "positions": [], "trades": [], "history": [{"t": now, "equity": start}]}


def paper_fields(state: dict, profile: dict) -> dict:
    """The paper account, its unfiltered shadow and how to trade them, for an engine job.
    A missing shadow starts as a copy of the account, so the two start level."""
    acc = state.get("paper") or new_paper(profile)
    shadow = state.get("paperShadow") or {**json.loads(json.dumps(acc)), "createdAt": now_ms()}
    trial = state.get("filterTrial") or {}
    return {
        "paper": acc,
        "shadow": shadow,
        "useFilter": bool(profile["settings"].get("tradeFilter", True)) and trial.get("result") != "behind",
        "budgets": (state.get("paperBudgets") or {}).get("shares"),
        "trail": profile["settings"].get("paperExit") == "trail",
        "lock": profile["settings"].get("paperExit") == "lock",
        "tradable": ndax.tradable(state),
    }


def save_paper(st: dict, result: dict) -> None:
    if result.get("paper") is not None:
        st["paper"] = result["paper"]
    if result.get("shadow") is not None:
        st["paperShadow"] = result["shadow"]
    if result.get("paperEvents"):
        st["paperEvents"] = (list(reversed(result["paperEvents"])) + st.get("paperEvents", []))[:50]
        ndax.queue_events(st, result["paperEvents"])
    st["filterTrial"] = filter_trial(st)
    st["paperBudgets"] = follow_results(st)


FILTER_TRIAL_TRADES = 100  # closed trades before the filter is judged against the shadow


def filter_trial(st: dict, now: Optional[int] = None) -> Optional[dict]:
    """The filtered account against the unfiltered shadow, on the trades both
    opened since the shadow began. After FILTER_TRIAL_TRADES closed trades the
    filter had a say on, it has proved itself (ahead) or is switched off (behind)."""
    acc, shadow = st.get("paper"), st.get("paperShadow")
    if not acc or not shadow:
        return None
    since = shadow.get("createdAt") or 0
    mine = [t for t in acc.get("trades", []) if (t.get("openedAt") or 0) >= since]
    theirs = [t for t in shadow.get("trades", []) if (t.get("openedAt") or 0) >= since]
    judged = sum(1 for t in mine if t.get("filter"))
    out = {"since": since, "trades": len(mine), "judged": judged, "shadowTrades": len(theirs), "need": FILTER_TRIAL_TRADES,
           "pnl": round(sum(t["pnl"] for t in mine), 2), "shadowPnl": round(sum(t["pnl"] for t in theirs), 2),
           "result": "testing"}
    prev = st.get("filterTrial") or {}
    if prev.get("result") in ("ahead", "behind") and prev.get("since") == since:
        out["result"], out["decidedAt"] = prev["result"], prev.get("decidedAt")
    elif judged >= FILTER_TRIAL_TRADES:
        out["result"], out["decidedAt"] = ("ahead" if out["pnl"] > out["shadowPnl"] else "behind"), now or now_ms()
    return out


# Each source's share of the paper account (app/js/paper.js BUDGETS). Once two
# sources have BUDGET_MIN_TRADES closed trades, once a week the one with the
# best average trade takes up to BUDGET_STEP from the worst, within the limits.
BUDGET_SHARES = {"opportunities": 0.4, "stockIdeas": 0.2, "cryptoIdeas": 0.2, "alerts": 0.2}
BUDGET_MIN_TRADES, BUDGET_STEP, BUDGET_MIN, BUDGET_MAX = 50, 0.05, 0.1, 0.5
WEEK_MS = 7 * 86400_000


def bucket_of(t: dict) -> str:
    setup = t.get("setup") or "signal"
    if setup == "signal":
        return "alerts"
    if setup == "scan":
        return "cryptoIdeas" if t.get("type") == "crypto" else "stockIdeas"
    return "opportunities"


def follow_results(st: dict, now: Optional[int] = None) -> dict:
    now = now or now_ms()
    b = st.get("paperBudgets") or {"shares": dict(BUDGET_SHARES), "at": now, "moves": []}
    if now - b["at"] < WEEK_MS:
        return b
    b = {**b, "shares": dict(b["shares"]), "at": now}
    stats = {}
    for t in (st.get("paper") or {}).get("trades", []):
        stats.setdefault(bucket_of(t), []).append(t.get("ret") or 0)
    avg = {k: sum(v) / len(v) for k, v in stats.items() if len(v) >= BUDGET_MIN_TRADES and k in b["shares"]}
    if len(avg) >= 2:
        best, worst = max(avg, key=avg.get), min(avg, key=avg.get)
        move = round(min(BUDGET_STEP, b["shares"][worst] - BUDGET_MIN, BUDGET_MAX - b["shares"][best]), 4)
        if avg[best] > avg[worst] and move > 0:
            b["shares"][best] = round(b["shares"][best] + move, 4)
            b["shares"][worst] = round(b["shares"][worst] - move, 4)
            b["moves"] = ([{"at": now, "from": worst, "to": best, "share": move}] + b.get("moves", []))[:20]
    return b


def edit_paper(action: str, key: str, price: Optional[float] = None, stop: Optional[float] = None,
               take: Optional[float] = None, trail: Optional[bool] = None,
               engine: Callable[[dict, int], dict] = run_engine) -> Optional[dict]:
    """You sell a paper position now ("sell") or move its stop and target ("levels"),
    and turn its trailing stop on or off (`trail`, None leaves it).
    A sale uses the server's latest price for it, else the one the app showed.
    Returns the account, or None when there is no such position or the levels don't fit."""
    with _run_locks["watch"]:  # not while a check is changing the account
        state = load_state()
        profile = state.get("profile")
        if not profile or not state.get("paper"):
            return None
        known = ((state.get("prices") or {}).get("values") or {}).get(key)
        job = {"mode": "paperEdit", "action": action, "key": key,
               "price": known if known else price, "stop": stop, "take": take, "trailStop": trail,
               **paper_fields(state, profile)}
        result = engine(job, 60)
        if not result.get("ok"):
            return None
        update_state(lambda st: save_paper(st, result))
        return result["paper"]


def reset_paper(start: Optional[float] = None) -> dict:
    def apply(st):
        profile = st.get("profile") or {"settings": {}}
        acc = new_paper({"settings": {**profile.get("settings", {}), **({"paperStart": start} if start else {})}})
        st["paper"], st["paperEvents"] = acc, []
        st["paperShadow"] = json.loads(json.dumps(acc))
        st["filterTrial"], st["paperBudgets"] = None, None

    with _run_locks["watch"]:  # not while a check is changing the account
        acc = update_state(apply)["paper"]
    _spawn(offer_ideas)
    return acc


def us_market_open(now: Optional[datetime] = None) -> bool:
    """Regular US stock hours, 9:30 to 16:00 New York time on weekdays (holidays not counted)."""
    t = (now or datetime.now(NEW_YORK)).astimezone(NEW_YORK)
    return t.weekday() < 5 and (t.hour, t.minute) >= (9, 30) and t.hour < 16


def price_items(state: dict, now: Optional[datetime] = None) -> List[dict]:
    """Holdings with a stop or target, and paper positions. Stocks only while their market is
    open, or once to get a first price for one bought after the close."""
    profile = state.get("profile") or {}
    known = (state.get("prices") or {}).get("values") or {}
    items, seen = [], set()
    rows = [h for h in profile.get("holdings", []) if h.get("stop") or h.get("take")] + list((state.get("paper") or {}).get("positions", [])) \
        + list((state.get("paperShadow") or {}).get("positions", []))
    stocks_open = us_market_open(now)
    for r in rows:
        k = f"{r['type']}:{r['symbol']}"
        if k in seen or (r["type"] == "stock" and not stocks_open and k in known):
            continue
        seen.add(k)
        items.append({x: r[x] for x in ("type", "symbol", "name", "geckoId") if x in r})
    return items


def run_prices(engine: Callable[[dict, int], dict] = run_engine) -> Optional[dict]:
    """Every minute: holdings' stop-loss and target, and the paper positions' exits."""
    lock = _run_locks["watch"]  # never at the same time as a watch run: both change holdings and paper
    if not lock.acquire(blocking=False):
        return None
    try:
        state = load_state()
        profile = state.get("profile")
        items = price_items(state)
        if not profile or not items:
            return None
        job = {
            "mode": "prices",
            "settings": engine_settings(profile),
            "items": items,
            "holdings": profile["holdings"],
            "paper": state.get("paper"),
            "shadow": state.get("paperShadow"),
        }
        try:
            result = engine(job, 120)
        except Exception as e:
            logger.warning("Price check failed: %s", e)
            update_state(lambda st: st["prices"].update(lastRunAt=now_ms(), errors={"engine": str(e)}))
            return None
        if result["alerts"] and state["subscriptions"]:
            deliver(result["alerts"], profile["settings"]["quietHours"])

        def apply(st):
            p = st.get("profile")
            if p:
                for h in p["holdings"]:
                    if h["id"] in result["holdingsAlerted"]:
                        h["alerted"] = result["holdingsAlerted"][h["id"]]
            if st["watch"] is not None and result["alerts"]:
                st["watch"]["lastAlerts"] = ([{"title": a["title"], "at": now_ms()} for a in result["alerts"]] + st["watch"].get("lastAlerts", []))[:20]
            save_paper(st, result)
            # Stocks aren't priced while their market is closed: keep their last price
            # for what is still held, so the app can still show what they are worth.
            held = {f"{r['type']}:{r['symbol']}" for r in [*(p or {}).get("holdings", []),
                    *(st.get("paper") or {}).get("positions", []), *(st.get("paperShadow") or {}).get("positions", [])]}
            old = {k: v for k, v in ((st.get("prices") or {}).get("values") or {}).items() if k in held}
            st["prices"] = {"lastRunAt": now_ms(), "values": {**old, **result["prices"]}, "errors": result["errors"]}

        update_state(apply)
        return result
    finally:
        lock.release()


SCOPES = ("stocks", "crypto")
SCOPE_PREFIX = {"stocks": "stock:", "crypto": "crypto:"}


def _scope_part(d: dict, scope: str) -> dict:
    return {k: v for k, v in (d or {}).items() if k.startswith(SCOPE_PREFIX[scope])}


def run_market(reason: str = "schedule", engine: Callable[[dict, int], dict] = run_engine, scope: str = "stocks",
               only: Optional[List[str]] = None) -> Optional[dict]:
    """The S&P 500 scan (scope "stocks") or the crypto scan (scope "crypto").
    `only` rescores just those crypto symbols after a fast move."""
    lock = _run_locks["market" if scope == "stocks" else "crypto"]
    if not lock.acquire(blocking=False):
        return None
    try:
        state = load_state()
        profile = state.get("profile")
        if not profile:
            return None
        import events
        muted = muted_setups(state)
        job = {
            "mode": "market", "scope": scope, "settings": engine_settings(profile),
            "prev": _scope_part(state["marketActions"], scope), "weights": _scope_part(state["marketWeights"], scope), "models": load_models("1D"),
            "events": events.load_events(events_dir()),
            "enabled": profile["settings"].get("setups") or {},
            "held": sorted(held_keys(state)),
            "announced": state.get("announced", []),
            "muted": sorted(muted),
            "buyStarts": _scope_part(state.get("buyStarts"), scope),
            "mood": state.get("marketMood") or {},
        }
        if scope == "crypto":
            job["items"] = crypto_items(state)
            if only:
                job["only"] = only
        try:
            result = engine(job, 3000)
        except Exception as e:
            logger.exception("%s scan failed", scope)

            def failed(st):
                scans = st.setdefault("scans", {})
                scans[scope] = {**(scans.get(scope) or {}), "error": str(e), "failedAt": now_ms()}
                st["market"] = merged_market(scans)
            update_state(failed)
            return None
        announced = set(state.get("announced", []))
        warnings = [w for w in result.get("warnings", []) if w["id"] not in announced]
        push = [a for a in [result.get("alert"), result.get("digest")] + warnings if a]
        if push and state["subscriptions"]:
            deliver(push, profile["settings"]["quietHours"], muted=muted)
        new_ids = (result["digest"]["ids"] if result.get("digest") else []) + [w["id"] for w in warnings]

        def apply(st):
            actions, weights = result.pop("actions", {}), result.pop("weights", {})
            levels = result.pop("levels", {})
            starts = result.pop("buyStarts", {})
            st["marketMood"] = {**(st.get("marketMood") or {}), **result.pop("mood", {})}
            # Each scan replaces only its own symbols' saved actions and weights.
            other = "crypto" if scope == "stocks" else "stocks"
            if only:
                st["marketActions"] = {**st["marketActions"], **actions}
                st["marketWeights"] = {**st["marketWeights"], **weights}
                st["cryptoLevels"] = {**st.get("cryptoLevels", {}), **levels}
                st["buyStarts"] = {**{k: v for k, v in (st.get("buyStarts") or {}).items() if k not in only}, **starts}
            else:
                st["buyStarts"] = {**_scope_part(st.get("buyStarts"), other), **starts}
                st["marketActions"] = {**_scope_part(st["marketActions"], other), **actions}
                st["marketWeights"] = {**_scope_part(st["marketWeights"], other), **weights}
                if scope == "crypto":
                    st["cryptoLevels"] = levels
            result["reason"] = reason
            view = {k: v for k, v in result.items() if k not in ("scanBuys", "scanSells")}
            view["paperBuys"] = result.get("scanBuys") or []
            scans = st.setdefault("scans", {})
            scans[scope] = rescored(scans.get(scope), view, only) if only else view
            st["market"] = merged_market(scans)
            remember(st, new_ids)

        update_state(apply)
        # Both markets' current ideas, so one missed earlier (the account was
        # busy, short of cash or just reset) is tried again on every scan.
        opps, buys = current_ideas(load_state())
        paper_opportunities(opps, engine, buys, result.get("scanSells") or [])
        return result
    finally:
        lock.release()


def current_ideas(state: dict):
    """The opportunities and buy ideas (within 1 ATR of their start) of the
    latest stock and crypto scans, for the paper account."""
    scans = state.get("scans") or {}
    opps = (state.get("market") or {}).get("opportunities") or []
    starts = state.get("buyStarts") or {}
    buys = sorted((b for x in scans.values() for b in _paper_buys(x or {}, starts)), key=lambda b: -(b.get("ev") or 0))
    return opps, buys


def _paper_buys(scan: dict, starts: dict) -> List[dict]:
    """A scan's buy ideas for the paper account. A scan saved by an older
    version has no paperBuys (stocks scan only on weekdays, so one can stay
    that way for days): they are rebuilt from its buy list."""
    if "paperBuys" in scan:
        return scan["paperBuys"]
    out = []
    for r in scan.get("buys") or []:
        start = starts.get(r["key"]) or {"at": scan.get("at") or 0, "entry": r.get("entry")}
        out.append({"id": f"scan:{r['key']}:{start['at']}", "setup": "scan", "key": r["key"], "symbol": r.get("symbol"),
                    "type": r.get("type"), "entry": r.get("entry"), "stop": r.get("stop"), "take": r.get("take"),
                    "ev": (r.get("score") or 0) / 100,
                    "ranAway": bool(r.get("entry") and start.get("entry") and r["entry"] > start["entry"] + (r.get("atr") or 0))})
    return out


def offer_ideas(engine: Callable[[dict, int], dict] = run_engine) -> Optional[dict]:
    """Right after a reset: buy the current ideas without waiting for a scan."""
    opps, buys = current_ideas(load_state())
    return paper_opportunities(opps, engine, buys, [])


def run_crypto(reason: str = "schedule", engine: Callable[[dict, int], dict] = run_engine, only: Optional[List[str]] = None) -> Optional[dict]:
    return run_market(reason, engine, scope="crypto", only=only)


def rescored(old: Optional[dict], new: dict, only: List[str]) -> dict:
    """A full scan's result with a few symbols scored again."""
    if not old or not old.get("at"):
        return new
    keys = set(only)
    out = dict(old)
    out["buys"] = sorted([r for r in old.get("buys", []) if r["key"] not in keys] + new.get("buys", []), key=lambda r: -(r.get("score") or 0))[:100]
    out["sells"] = sorted([r for r in old.get("sells", []) if r["key"] not in keys] + new.get("sells", []), key=lambda r: r.get("score") or 0)[:100]
    out["newBuys"], out["newSells"] = new.get("newBuys", []), new.get("newSells", [])
    out["paperBuys"] = [b for b in old.get("paperBuys", []) if b["key"] not in keys] + new.get("paperBuys", [])
    out["rescoredAt"] = new.get("at")
    return out


def _merge_records(parts: List[dict]) -> dict:
    out = {}
    for recs in parts:
        for k, r in (recs or {}).items():
            o = out.setdefault(k, {"n": 0, "wins": 0, "sum": 0.0})
            o["n"] += r.get("n", 0)
            o["wins"] += r.get("wins", 0)
            o["sum"] += r.get("avg", 0) * r.get("n", 0)
    return {k: {"n": o["n"], "wins": o["wins"], "avg": round(o["sum"] / o["n"], 5) if o["n"] else 0} for k, o in out.items()}


def merged_market(scans: dict) -> Optional[dict]:
    """What the app shows: the latest stock scan and crypto scan together."""
    stocks, crypto = scans.get("stocks") or {}, scans.get("crypto") or {}
    done = [x for x in (stocks, crypto) if x.get("at")]
    if not done:
        errs = [x.get("error") for x in (stocks, crypto) if x.get("error")]
        return {"error": "; ".join(errs)} if errs else None
    both = lambda k: [r for x in done for r in (x.get(k) or [])]  # noqa: E731
    opps = sorted(both("opportunities"), key=lambda o: (not o.get("proven"), -(o.get("ev") or 0)))
    out = {
        "at": max(x["at"] for x in done),
        "scanned": sum(x.get("scanned", 0) for x in done),
        "total": sum(x.get("total", 0) for x in done),
        "buys": sorted(both("buys"), key=lambda r: -(r.get("score") or 0))[:200],
        "sells": sorted(both("sells"), key=lambda r: r.get("score") or 0)[:200],
        "newBuys": both("newBuys"),
        "newSells": both("newSells"),
        "errors": {k: v for x in done for k, v in (x.get("errors") or {}).items()},
        "opportunities": opps[:30],
        "warnings": both("warnings"),
        "stocksAt": stocks.get("at"), "stocksScanned": stocks.get("scanned"),
        "cryptoAt": crypto.get("rescoredAt") or crypto.get("at"), "cryptoScanned": crypto.get("scanned"), "cryptoTotal": crypto.get("total"),
    }
    if any(x.get("records") for x in done):
        out["records"] = _merge_records([x.get("records") for x in done])
        out["counts"] = {k: sum((x.get("counts") or {}).get(k, 0) for x in done) for k in out["records"]}
    errs = [f"{name} scan failed: {x['error']}" for name, x in (("Stock", stocks), ("Crypto", crypto)) if x.get("error")]
    if errs:
        out["error"] = "; ".join(errs)
    return out


# ---------------------------------------------------------------------------
# Crypto around the clock
# ---------------------------------------------------------------------------

def crypto_items(state: dict) -> Optional[List[dict]]:
    """Every qualifying coin on Coinbase and Kraken, refreshed once a day;
    None (the top 50) when neither exchange has answered yet."""
    import crypto
    uni = state.get("cryptoUniverse") or {}
    if uni.get("items") and now_ms() - (uni.get("at") or 0) < UNIVERSE_EVERY_MS:
        return uni["items"]
    try:
        items = crypto.universe(crypto.fetch_tickers())
        if len(items) < 20:
            raise RuntimeError(f"only {len(items)} coins qualified")
        update_state(lambda st: st.update(cryptoUniverse={"at": now_ms(), "items": items, "error": None}))
        return items
    except Exception as e:
        logger.warning("Crypto list failed: %s", e)
        update_state(lambda st: st.update(cryptoUniverse={**(st.get("cryptoUniverse") or {}), "error": str(e), "failedAt": now_ms()}))
        return uni.get("items") or None


def run_pulse(fetch: Optional[Callable[[], dict]] = None, engine: Callable[[dict, int], dict] = run_engine) -> List[str]:
    """Every minute: all crypto prices in two requests. A coin that moved
    1.5 ATR or more since its last scan is scored again right away."""
    import crypto
    lock = _run_locks["pulse"]
    if not lock.acquire(blocking=False):
        return []
    try:
        state = load_state()
        update_state(lambda st: st.update(pulse={**(st.get("pulse") or {}), "lastRunAt": now_ms()}))
        if not state.get("profile") or not state.get("cryptoLevels"):
            return []
        try:
            tickers = (fetch or crypto.fetch_tickers)()
        except Exception as e:
            update_state(lambda st: st.update(pulse={**(st.get("pulse") or {}), "error": str(e)}))
            return []
        movers = crypto.fast_movers({s: t["price"] for s, t in tickers.items()}, state["cryptoLevels"])
        update_state(lambda st: st.update(pulse={**(st.get("pulse") or {}), "lastRunAt": now_ms(), "error": None, "movers": movers[:20],
                                                 **({"lastMoveAt": now_ms()} if movers else {})}))
        if movers:
            _spawn(lambda: run_crypto("fast move", engine=engine, only=movers[:30]))
        return movers
    finally:
        lock.release()


def crypto_slot(now: int) -> int:
    """Which crypto scan slot `now` is in: every CRYPTO_SCAN_MINUTES, a minute after the candle edge."""
    return (now - CLOSE_DELAY_MS) // (CRYPTO_SCAN_MINUTES * 60_000)


def crypto_due(state: dict, now: int) -> bool:
    return bool(state.get("profile")) and state.get("lastCryptoSlot") != crypto_slot(now)


def pulse_due(state: dict, now: int) -> bool:
    return bool(state.get("cryptoLevels")) and now - ((state.get("pulse") or {}).get("lastRunAt") or 0) >= PULSE_EVERY_MS


def events_dir() -> str:
    return os.path.join(DATA_DIR, "events")


def held_keys(state: dict) -> set:
    """What you hold and what the paper account holds."""
    profile = state.get("profile") or {}
    return {h["key"] for h in profile.get("holdings", [])} | {p["key"] for p in (state.get("paper") or {}).get("positions", [])}


def remember(st: dict, ids: List[str]) -> None:
    """Ids of alerts sent, so each opportunity or warning goes out once."""
    if ids:
        st["announced"] = (st.get("announced", []) + [i for i in ids if i not in st.get("announced", [])])[-500:]


def paper_opportunities(opportunities: List[dict], engine: Callable[[dict, int], dict] = run_engine,
                        scan_buys: Optional[List[dict]] = None, scan_sells: Optional[List[dict]] = None) -> Optional[dict]:
    """The paper account takes the scan's opportunities and new buy ideas, and
    sells its scan trades that turned Sell (in the watch lock, since watch runs
    change the same account)."""
    scan_buys, scan_sells = scan_buys or [], scan_sells or []
    if not opportunities and not scan_buys and not scan_sells:
        return None
    lock = _run_locks["watch"]
    if not lock.acquire(timeout=900):
        logger.warning("Paper account busy; the opportunities wait for the next scan")
        return None
    try:
        state = load_state()
        profile = state.get("profile")
        if not profile:
            return None
        fields = paper_fields(state, profile)
        held = {p["key"] for a in (fields["paper"], fields["shadow"]) for p in a.get("positions", []) if p.get("setup") == "scan"}
        sells = [s for s in scan_sells if s["key"] in held]
        if not opportunities and not scan_buys and not sells:
            return None
        job = {"mode": "paper", "opportunities": opportunities, "scanBuys": scan_buys, "scanSells": sells,
               "riskPct": profile["settings"].get("riskPct", 1), **fields}
        try:
            result = engine(job, 120)
        except Exception:
            logger.exception("Paper opportunities failed")
            return None
        update_state(lambda st: save_paper(st, result))
        return result
    finally:
        lock.release()


def run_events(reason: str = "schedule", refresher: Optional[Callable] = None) -> Optional[dict]:
    """Hourly: the setups' outside data, then earnings warnings for what you hold."""
    import events
    lock = _run_locks["events"]
    if not lock.acquire(blocking=False):
        return None
    try:
        update_state(lambda st: st.update(events={**(st.get("events") or {}), "lastRunAt": now_ms()}))
        try:
            status = (refresher or events.refresh)(events_dir(), events.sp500_ciks(SP500_FILE))
        except Exception as e:
            logger.exception("Event data refresh failed")
            status = {"error": str(e)}
        state = load_state()
        profile = state.get("profile")
        if not profile:
            return status
        today = datetime.now(NEW_YORK).date()
        announced = set(state.get("announced", []))
        warnings = [w for w in events.earnings_warnings(events.next_earnings(events_dir()), held_keys(state), today) if w["id"] not in announced]
        if warnings and state["subscriptions"]:
            deliver(warnings, profile["settings"]["quietHours"])
        update_state(lambda st: remember(st, [w["id"] for w in warnings]))
        return {**status, "warnings": warnings}
    finally:
        lock.release()


def events_due(state: dict, now: int) -> bool:
    return bool(state.get("profile")) and now - ((state.get("events") or {}).get("lastRunAt") or 0) >= EVENTS_EVERY_MS


# ---------------------------------------------------------------------------
# Machine learning (ml.py does the training in its own process)
# ---------------------------------------------------------------------------

def load_models(tf: str) -> Optional[dict]:
    import ml
    return ml.load_models(tf)


def model_summaries() -> Dict[str, dict]:
    import ml
    out = {}
    for tf in sorted(TIMEFRAMES):
        s = ml.summary(load_models(tf))
        if s:
            out[tf] = s
    return out


def train_timeframes(profile: dict) -> List[str]:
    """Every timeframe, so any chart gets ML votes. The alert timeframe trains
    first, then the daily chart the market scan uses."""
    first = [profile["settings"]["alertTf"], "1D"]
    return list(dict.fromkeys(first + sorted(TIMEFRAMES)))


def run_ml(job: dict, timeout: int) -> dict:
    proc = subprocess.run([sys.executable, ML], input=json.dumps(job), capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "training failed").strip().splitlines()[-1][:300])
    return json.loads(proc.stdout)


def run_train(reason: str = "schedule", trainer: Callable[[dict, int], dict] = run_ml) -> Optional[dict]:
    lock = _run_locks["train"]
    if not lock.acquire(blocking=False):
        return None
    try:
        profile = load_state().get("profile")
        if not profile:
            return None
        update_state(lambda st: st["training"].update(runningSince=now_ms()))
        results = {}
        for tf in train_timeframes(profile):
            job = {"tf": tf, "items": watch_items(profile), "settings": engine_settings(profile), "total": TRAIN_SYMBOLS}
            try:
                results[tf] = {**trainer(job, 3600), "at": now_ms()}
            except Exception as e:
                logger.exception("Training %s failed", tf)
                results[tf] = {"error": str(e), "at": now_ms()}

        def apply(st):
            st["training"] = {"lastRunAt": now_ms(), "reason": reason, "results": {**st["training"].get("results", {}), **results}}
            # New models change the votes, so method weights are learned again.
            st["weights"], st["marketWeights"] = {}, {}

        update_state(apply)
        return results
    finally:
        lock.release()


def train_schedule():
    """(weekday 0-6, hour, minute) from TRAIN_AT like "Sun 03:00"."""
    try:
        day, at = TRAIN_AT.strip().lower().split()
        h, m = (int(x) for x in at.split(":"))
        if day[:3] in DAYS and 0 <= h < 24 and 0 <= m < 60:
            return DAYS.index(day[:3]), h, m
    except ValueError:
        pass
    return 6, 3, 0


def train_slot(now: datetime) -> datetime:
    """The latest weekly training time at or before `now`."""
    day, h, m = train_schedule()
    slot = now.replace(hour=h, minute=m, second=0, microsecond=0) - timedelta(days=(now.weekday() - day) % 7)
    return slot if slot <= now else slot - timedelta(days=7)


def next_train_at(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(tz())
    return (train_slot(now) + timedelta(days=7)).isoformat()


def train_due(state: dict, now: datetime) -> Optional[str]:
    """A slot id when training should run: the weekly time passed, or a timeframe has no models yet."""
    profile = state.get("profile")
    if not profile:
        return None
    slot = train_slot(now).isoformat()
    if state.get("lastTrainSlot") != slot:
        return slot
    missing = [tf for tf in train_timeframes(profile) if not os.path.exists(os.path.join(DATA_DIR, "models", f"{tf}.json"))]
    last = (state.get("training") or {}).get("lastRunAt") or 0
    # After a failed training, wait 6 hours before trying again.
    if missing and now_ms() - last >= 6 * 3600_000:
        return slot
    return None


def run_in_background(what: str) -> None:
    if what == "market":  # both scans
        for fn in (run_market, run_crypto):
            threading.Thread(target=fn, args=("manual",), daemon=True).start()
        return
    target = {"crypto": run_crypto, "train": run_train, "events": run_events}.get(what, run_watch)
    threading.Thread(target=target, args=("manual",), daemon=True).start()


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

def scan_times() -> List[str]:
    out = []
    for t in MARKET_SCAN_TIMES.split(","):
        try:
            h, m = (int(x) for x in t.strip().split(":"))
            if 0 <= h < 24 and 0 <= m < 60:
                out.append(f"{h:02d}:{m:02d}")
        except ValueError:
            continue
    return sorted(set(out)) or DEFAULT_SCAN_TIMES.split(",")


def due_market_slot(now: datetime, last_slot: Optional[str]) -> Optional[str]:
    """The latest scan time today that has passed and hasn't run yet.
    Weekdays only: stocks don't trade at the weekend, and crypto has its own scan."""
    if now.weekday() >= 5:
        return None
    due = None
    for t in scan_times():
        h, m = (int(x) for x in t.split(":"))
        slot = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if slot <= now and now - slot < timedelta(hours=3):
            due = slot.isoformat()
    return due if due and due != last_slot else None


def next_market_at(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(tz())
    for day in range(4):  # over a weekend, Monday's first scan
        for t in scan_times():
            h, m = (int(x) for x in t.split(":"))
            slot = (now + timedelta(days=day)).replace(hour=h, minute=m, second=0, microsecond=0)
            if slot > now and slot.weekday() < 5:
                return slot.isoformat()
    return ""


def candle_closed_since(tf: str, last: int, now: int) -> bool:
    """Whether a candle of `tf` closed (a minute ago or more) since the last run."""
    step = TF_SECONDS.get(tf, 86400) * 1000
    return (now - CLOSE_DELAY_MS) // step > (last - CLOSE_DELAY_MS) // step


def clear_watch_soon(st: dict, started: int) -> None:
    """A run answers the asked-for check, unless the ask came in after the run started."""
    if (st.get("watchSoonAt") or 0) <= started + WATCH_SOON_MS:
        st["watchSoonAt"] = None


def watch_due(state: dict, now: int) -> bool:
    """Right after each candle of the alert timeframe closes, every few minutes
    in between, and shortly after the watchlist or settings change."""
    profile = state.get("profile")
    if not profile:
        return False
    if state.get("watchSoonAt") and now >= state["watchSoonAt"]:
        return True
    tf = profile["settings"]["alertTf"]
    every = WATCH_EVERY.get(tf, 15) * 60_000
    last = state["watch"].get("lastRunAt") or 0
    return now - last >= every or candle_closed_since(tf, last, now)


def prices_due(state: dict, now: int) -> bool:
    return now - ((state.get("prices") or {}).get("lastRunAt") or 0) >= PRICES_EVERY_MS


def run_ndax() -> List[dict]:
    """Real NDAX orders for the paper account's latest crypto buys and sells."""
    return ndax.process(load_state, update_state, tz())


def _spawn(fn) -> None:
    """Each job runs in its own thread, so a long market scan or training never
    delays the candle-close and every-minute checks. Each job's lock skips a
    run while the previous one is still going."""
    threading.Thread(target=fn, daemon=True).start()


def start_scheduler() -> None:
    def loop():
        time.sleep(15)
        while True:
            try:
                state = load_state()
                now = now_ms()
                if watch_due(state, now):
                    _spawn(run_watch)
                elif prices_due(state, now):
                    _spawn(run_prices)
                slot = due_market_slot(datetime.now(tz()), state.get("lastMarketSlot"))
                if slot:
                    update_state(lambda st: st.update(lastMarketSlot=slot))
                    _spawn(run_market)
                if crypto_due(state, now):
                    cslot = crypto_slot(now)
                    update_state(lambda st: st.update(lastCryptoSlot=cslot))
                    _spawn(run_crypto)
                elif pulse_due(state, now):
                    _spawn(run_pulse)
                if events_due(state, now):
                    _spawn(run_events)
                if state.get("ndaxQueue"):
                    _spawn(run_ndax)
                if ndax.coins_due(state, now):
                    update_state(lambda st: ndax._box(st).update(coinsAt=now))
                    _spawn(lambda: ndax.refresh_coins(update_state))
                train = train_due(state, datetime.now(tz()))
                if train:
                    update_state(lambda st: st.update(lastTrainSlot=train))
                    _spawn(run_train)
            except Exception:
                logger.exception("Scheduler step failed")
            time.sleep(15)

    threading.Thread(target=loop, name="trade-scheduler", daemon=True).start()
