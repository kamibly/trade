"""
The prediction scoreboard: every live call graded once its answer is known.

Each watch run and market scan sends its scored candles (engine.mjs
observe()): the call (buy, sell or hold), the candle's close, high and low,
the stop and target distances in ATRs, and which voters leaned firmly up or
down. Each call is graded like the trade it would open, from that close:

- a Buy (or a voter leaning up) is right when the price reaches its target
  (takeAtr ATRs up) before its stop (stopAtr ATRs down), a Sell (or a voter
  leaning down) when it falls takeAtr ATRs before rising stopAtr ATRs. A
  candle that touches both counts as the stop. With neither hit within CAP
  candles, the move by then decides it. So a fast coin is graded in a candle
  or two and a slow stock can take weeks;
- its return is the move to that exit (a Buy pays the round-trip fee, a Sell
  earns the drop it avoided);
- "vs hold" is that return against the average move of every chart of the
  same kind (stocks or crypto) over the same candles, so a Buy in a rising
  market only gets credit for beating it;
- the trade filter's Buys are graded by what it did with them: blocked, made
  smaller, or kept at full size or bigger.

Grades add up per day, so the app can ask for the last 30, 90 or all days.
The latest graded calls of each source are kept for the app's list.
Everything lives in DATA_DIR/scoreboard.json, apart from trade.json.
"""
import json
import os
import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional

import service

CAP = 30                  # candles a call may wait for its stop or target (as the turning-point models' label)
FEE = {"stock": 0.002, "crypto": 0.004}   # round trip: IBKR about 0.1% a side on $1,000, NDAX 0.2%
MIN_CALLS = 30            # below this a source shows its count, not a score
KEEP_POINTS = CAP + 15    # candles kept per chart
KEEP_DAYS = 400
KEEP_RECENT = 50          # graded calls kept per source for the app's list
MAX_PENDING_AGE_MS = 120 * 86_400_000
SOURCES_CALLS = ("buy", "sell")
FILTER_BUCKETS = ("f:bigger", "f:smaller", "f:blocked")

_lock = threading.Lock()


def path() -> str:
    return os.path.join(service.DATA_DIR, "scoreboard.json")


def _empty() -> dict:
    return {"prices": {}, "pending": {}, "days": {}, "recent": {}, "voters": {}, "since": None}


def load() -> dict:
    try:
        with open(path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return {**_empty(), **data}
    except (FileNotFoundError, ValueError):
        return _empty()


def _save(board: dict) -> None:
    os.makedirs(service.DATA_DIR, exist_ok=True)
    tmp = path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(board, f, separators=(",", ":"))
    os.replace(tmp, path())


def _day(t: int) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")


def _add_point(points: List[list], point: list) -> None:
    """One [time, close, high, low] per candle; a candle still forming keeps
    its latest read."""
    if points and points[-1][0] == point[0]:
        points[-1] = point
    elif not points or points[-1][0] < point[0]:
        points.append(point)
        del points[:-KEEP_POINTS]


def _num(v, default=None):
    try:
        v = float(v)
        return v if v == v else default
    except (TypeError, ValueError):
        return default


def record(observations: Optional[List[dict]], voters: Optional[Dict[str, list]], now: Optional[int] = None) -> int:
    """Saves a run's scored candles and grades every call whose answer is in.
    Returns how many candles were graded."""
    if not observations:
        return 0
    now = now or service.now_ms()
    with _lock:
        board = load()
        board["since"] = board["since"] or now
        board["voters"].update(voters or {})
        for o in observations:
            if not isinstance(o, dict) or not (_num(o.get("p"), 0) > 0) or not o.get("t"):
                continue
            chart = f"{o['key']}:{o['tf']}"
            p = float(o["p"])
            _add_point(board["prices"].setdefault(chart, []), [int(o["t"]), p, _num(o.get("h"), p), _num(o.get("l"), p)])
            # The latest read of a candle wins: a call made and dropped while the
            # candle was forming doesn't count, the one standing at its close does.
            item = {"key": o["key"], "type": o.get("type", "stock"), "tf": o["tf"], "t": int(o["t"]), "p": p,
                    "atr": _num(o.get("atr"), 0), "sa": _num(o.get("sa"), 2), "ta": _num(o.get("ta"), 3),
                    "a": o.get("a", "hold"), "up": o.get("up") or [], "down": o.get("down") or [], "at": now}
            if "f" in o and o["f"] is not None:
                item["f"] = o["f"]
            pid = f"{chart}:{o['t']}"
            if item["a"] != "hold" or item["up"] or item["down"]:
                board["pending"][pid] = item
            else:
                board["pending"].pop(pid, None)
        graded = grade(board, now)
        _save(board)
        return graded


def _index(points: List[list], t: int) -> Optional[int]:
    for i, pt in enumerate(points):
        if pt[0] == t:
            return i
    return None


def exit_of(points: List[list], i: int, item: dict, direction: int) -> Optional[dict]:
    """Where a trade opened at candle i's close would have ended: at its target,
    its stop, or the close CAP candles later. Only closed candles count (the
    newest one may still be forming); None while it is still open."""
    p, atr = item["p"], item["atr"]
    stop = p - direction * item["sa"] * atr
    target = p + direction * item["ta"] * atr
    closed = len(points) - 1
    for j in range(i + 1, min(i + CAP, closed - 1) + 1):
        _, close, high, low = (points[j] + [points[j][1]] * 2)[:4]
        if atr > 0:
            worst, best = (low, high) if direction > 0 else (high, low)
            if (worst - stop) * direction <= 0:
                return {"how": "stop", "price": stop, "j": j}
            if (best - target) * direction >= 0:
                return {"how": "target", "price": target, "j": j}
        if j == i + CAP:
            return {"how": "cap", "price": close, "j": j}
    return None


def grade(board: dict, now: int) -> int:
    baselines: Dict[tuple, Optional[float]] = {}

    def baseline(tf: str, kind: str, t0: int, t1: int) -> Optional[float]:
        """The average move of every chart of this kind from candle t0's close to t1's."""
        k = (tf, kind, t0, t1)
        if k not in baselines:
            moves = []
            for chart, pts in board["prices"].items():
                if not (chart.startswith(f"{kind}:") and chart.endswith(f":{tf}")):
                    continue
                a, b = _index(pts, t0), _index(pts, t1)
                if a is not None and b is not None and pts[a][1] > 0:
                    moves.append(pts[b][1] / pts[a][1] - 1)
            baselines[k] = sum(moves) / len(moves) if moves else None
        return baselines[k]

    graded = 0
    for pid, item in list(board["pending"].items()):
        if "p" not in item:  # recorded before calls were graded by stop or target
            del board["pending"][pid]
            continue
        points = board["prices"].get(f"{item['key']}:{item['tf']}") or []
        i = _index(points, item["t"])
        directions = ([1] if item["a"] == "buy" or item["up"] else []) + ([-1] if item["a"] == "sell" or item["down"] else [])
        exits = {d: exit_of(points, i, item, d) for d in directions} if i is not None else {}
        if i is None or any(e is None for e in exits.values()):
            if now - item.get("at", now) > MAX_PENDING_AGE_MS:
                del board["pending"][pid]
            continue
        del board["pending"][pid]
        fee = FEE.get(item["type"], FEE["stock"])
        day = board["days"].setdefault(_day(item["t"]), {}).setdefault(item["type"], {})
        outcomes = {}
        for d, e in exits.items():
            move = e["price"] / item["p"] - 1
            base = baseline(item["tf"], item["type"], item["t"], points[e["j"]][0])
            base = move if base is None else base
            # A Buy earns the move less the fee; a Sell earns the drop it avoided.
            r = move - fee if d > 0 else -move
            outcomes[d] = {"r": r, "edge": (move - base) * d,
                           "entry": {"key": item["key"], "tf": item["tf"], "t": item["t"], "ret": round(move, 5),
                                     "how": e["how"], "candles": e["j"] - i, "dir": d, "r": round(r, 5), "right": r > 0}}

        def add(source: str, d: int):
            o = outcomes[d]
            s = day.setdefault(source, [0, 0, 0.0, 0.0])
            s[0] += 1
            s[1] += 1 if o["r"] > 0 else 0
            s[2] = round(s[2] + o["r"], 6)
            s[3] = round(s[3] + o["edge"], 6)
            recent = board["recent"].setdefault(source, [])
            recent.insert(0, o["entry"])
            del recent[KEEP_RECENT:]

        if item["a"] in SOURCES_CALLS:
            add(item["a"], 1 if item["a"] == "buy" else -1)
        if item["a"] == "buy" and "f" in item:
            f = item["f"]
            add("f:blocked" if not f > 0 else "f:smaller" if f < 1 else "f:bigger", 1)
        for vid in item["up"]:
            add(f"v:{vid}", 1)
        for vid in item["down"]:
            add(f"v:{vid}", -1)
        graded += 1
    cutoff = _day(now // 1000 - KEEP_DAYS * 86_400)
    for d in [d for d in board["days"] if d < cutoff]:
        del board["days"][d]
    return graded


def _row(source: str, label: str, s: list) -> dict:
    n = s[0]
    row = {"id": source, "label": label, "n": n}
    if n >= MIN_CALLS:
        row.update(right=round(s[1] / n, 4), avg=round(s[2] / n, 5), edge=round(s[3] / n, 5))
    return row


def summary(kind: str = "all", days: Optional[int] = 30, now: Optional[int] = None) -> dict:
    """The app's Scoreboard tab: the calls, the voters (by group, with their
    methods) and the trade filter, over the last `days` days (None: all)."""
    now = now or service.now_ms()
    board = load()
    start = _day(now // 1000 - days * 86_400) if days else ""
    totals: Dict[str, list] = {}
    for d, kinds in board["days"].items():
        if d < start:
            continue
        for k, sources in kinds.items():
            if kind != "all" and k != kind:
                continue
            for src, s in sources.items():
                t = totals.setdefault(src, [0, 0, 0.0, 0.0])
                for i in range(4):
                    t[i] += s[i]
    zero = [0, 0, 0.0, 0.0]
    names = board["voters"]
    groups: Dict[str, dict] = {}
    for g, title in GROUPS.items():
        if g == "ml":
            continue
        methods = sorted((vid for vid, (_, grp) in names.items() if grp == g), key=lambda v: names[v][0])
        groups[g] = {**_row(f"v:g:{g}", title, totals.get(f"v:g:{g}", zero)),
                     "methods": [_row(f"v:{v}", names[v][0], totals.get(f"v:{v}", zero)) for v in methods]}
    ml = [_row(f"v:{vid}", name, totals.get(f"v:{vid}", zero)) for vid, (name, grp) in sorted(names.items()) if grp == "ml"]
    filt = [_row(src, label, totals.get(src, zero)) for src, label in
            zip(FILTER_BUCKETS, ("Full size or bigger", "Made smaller", "Blocked"))]
    return {
        "kind": kind, "days": days, "minCalls": MIN_CALLS, "cap": CAP, "since": board["since"],
        "pending": len(board["pending"]),
        "calls": [_row("buy", "Buy", totals.get("buy", zero)), _row("sell", "Sell", totals.get("sell", zero))],
        "groups": list(groups.values()),
        "ml": ml,
        "filter": filt,
    }


def recent(source: str, kind: str = "all") -> List[dict]:
    """A source's latest graded calls, newest first."""
    rows = load()["recent"].get(source) or []
    return [r for r in rows if kind == "all" or r["key"].startswith(f"{kind}:")]


# The method groups, as app/js/signals.js names them.
GROUPS = {
    "trend": "Trend",
    "momentum": "Momentum",
    "volatility": "Volatility",
    "volume": "Volume",
    "structure": "Price structure",
    "stats": "Statistical forecasts",
    "ml": "Machine learning",
}
