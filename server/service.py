"""
Background work for trade-service: the saved state, the two scheduled checks,
and app notifications (Web Push).

The scoring itself happens in engine.mjs, which reuses the app's JavaScript so
the server and the phone agree on every score. This module runs it with Node.

Environment variables:
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT  - app notifications
    TRADE_TZ           - time zone for quiet hours and scan times, default America/Toronto
    MARKET_SCAN_TIMES  - when the S&P 500 and top-50 crypto scan runs, default "09:45,12:30,15:45,20:00"
    TWELVE_DATA_KEY    - optional; backup for stocks Yahoo Finance can't serve
    DATA_DIR           - where trade.json is kept, default /data
    TRAIN_AT           - when the machine-learning models retrain each week, default "Sun 03:00"
    TRAIN_SYMBOLS      - how many charts the models learn from, default 120
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

logger = logging.getLogger("trade-service")

VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:you@example.com")
TZ_NAME = os.environ.get("TRADE_TZ", "America/Toronto")
MARKET_SCAN_TIMES = os.environ.get("MARKET_SCAN_TIMES", "09:45,12:30,15:45,20:00")
TWELVE_DATA_KEY = os.environ.get("TWELVE_DATA_KEY", "")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
STATE_FILE = os.path.join(DATA_DIR, "trade.json")
ENGINE = os.environ.get("ENGINE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine.mjs"))
NODE = os.environ.get("NODE_BIN", "node")
ML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml.py")
TRAIN_AT = os.environ.get("TRAIN_AT", "Sun 03:00")
TRAIN_SYMBOLS = int(os.environ.get("TRAIN_SYMBOLS", "120") or 120)
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# How often the watchlist and holdings are checked, by alert timeframe (minutes).
WATCH_EVERY = {"15m": 5, "1h": 15, "1D": 15, "1W": 60}
QUIET_START, QUIET_END = 22, 7
TIMEFRAMES = set(WATCH_EVERY)

_lock = threading.RLock()
_run_locks = {"watch": threading.Lock(), "market": threading.Lock(), "train": threading.Lock()}


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
        "training": {"lastRunAt": None, "results": {}},  # last model training per timeframe
        "lastTrainSlot": None,
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
            "buyAt": buy,
            "sellAt": sell,
            "stopAtr": _num(s.get("stopAtr"), 2, 0.5, 10),
            "takeAtr": _num(s.get("takeAtr"), 3, 0.5, 20),
            "quietHours": bool(s.get("quietHours", True)),
        },
        "updatedAt": int(_num(raw.get("updatedAt"), now_ms(), 0, 1e15)),
    }


def set_profile(raw: dict) -> dict:
    profile = clean_profile(raw)

    def apply(state):
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


def deliver(alerts: List[dict], quiet: bool, when: Optional[datetime] = None) -> int:
    """Sends alerts; during quiet hours only urgent ones (stop-loss hits)."""
    when = when or datetime.now(tz())
    sent = 0
    for a in alerts:
        if quiet and in_quiet_hours(when) and not a.get("urgent"):
            continue
        payload = {"title": a["title"], "body": a["body"], "tag": f"{a.get('kind')}:{a.get('key', '')}", "hash": a.get("hash", "signals")}
        sent += send_to_all(payload)
    return sent


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
    return {"buyAt": s["buyAt"], "sellAt": s["sellAt"], "stopAtr": s["stopAtr"], "takeAtr": s["takeAtr"], "twelveKey": TWELVE_DATA_KEY}


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
        if not profile or not state["subscriptions"]:
            return None
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
        }
        try:
            result = engine(job, 600)
        except Exception as e:
            logger.exception("Watch run failed")
            update_state(lambda st: st["watch"].update(lastRunAt=now_ms(), errors={"engine": str(e)}))
            return None
        sent = deliver(result["alerts"], profile["settings"]["quietHours"])

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

        update_state(apply)
        return result
    finally:
        lock.release()


def run_market(reason: str = "schedule", engine: Callable[[dict, int], dict] = run_engine) -> Optional[dict]:
    lock = _run_locks["market"]
    if not lock.acquire(blocking=False):
        return None
    try:
        state = load_state()
        profile = state.get("profile")
        if not profile:
            return None
        job = {"mode": "market", "settings": engine_settings(profile), "prev": state["marketActions"], "weights": state["marketWeights"], "models": load_models("1D")}
        try:
            result = engine(job, 3000)
        except Exception as e:
            logger.exception("Market scan failed")
            update_state(lambda st: st.update(market={**(st.get("market") or {}), "error": str(e), "failedAt": now_ms()}))
            return None
        if result.get("alert") and state["subscriptions"]:
            deliver([result["alert"]], profile["settings"]["quietHours"])

        def apply(st):
            st["marketActions"] = result.pop("actions", {})
            st["marketWeights"] = result.pop("weights", {})
            result["reason"] = reason
            st["market"] = result

        update_state(apply)
        return result
    finally:
        lock.release()


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
    """The alert timeframe and the daily chart the market scan uses."""
    return sorted({profile["settings"]["alertTf"], "1D"})


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
    target = {"market": run_market, "train": run_train}.get(what, run_watch)
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
    return sorted(set(out)) or ["09:45", "12:30", "15:45", "20:00"]


def due_market_slot(now: datetime, last_slot: Optional[str]) -> Optional[str]:
    """The latest scan time today that has passed and hasn't run yet."""
    due = None
    for t in scan_times():
        h, m = (int(x) for x in t.split(":"))
        slot = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if slot <= now and now - slot < timedelta(hours=3):
            due = slot.isoformat()
    return due if due and due != last_slot else None


def next_market_at(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(tz())
    for day in (0, 1):
        for t in scan_times():
            h, m = (int(x) for x in t.split(":"))
            slot = (now + timedelta(days=day)).replace(hour=h, minute=m, second=0, microsecond=0)
            if slot > now:
                return slot.isoformat()
    return ""


def watch_due(state: dict, now: int) -> bool:
    profile = state.get("profile")
    if not profile:
        return False
    every = WATCH_EVERY.get(profile["settings"]["alertTf"], 15) * 60_000
    last = state["watch"].get("lastRunAt") or 0
    return now - last >= every


def start_scheduler() -> None:
    def loop():
        time.sleep(15)
        while True:
            try:
                state = load_state()
                if watch_due(state, now_ms()):
                    run_watch()
                slot = due_market_slot(datetime.now(tz()), state.get("lastMarketSlot"))
                if slot:
                    update_state(lambda st: st.update(lastMarketSlot=slot))
                    run_market()
                train = train_due(load_state(), datetime.now(tz()))
                if train:
                    update_state(lambda st: st.update(lastTrainSlot=train))
                    run_train()
            except Exception:
                logger.exception("Scheduler step failed")
            time.sleep(30)

    threading.Thread(target=loop, name="trade-scheduler", daemon=True).start()
