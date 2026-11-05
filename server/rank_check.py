"""
One-off check: would the ML votes do better if each day's stocks were ranked
against each other, instead of each stock being judged on its own?

It trains LightGBM the way the weekly training does (daily candles, the same
stock charts, oldest ~70% trains, newest ~30% tests) and grades its test
period two ways:

- now:    up vote when the vote is +0.3 or more, down at -0.3 or less (today's rule)
- ranked: each day, the top quarter of stocks by the model's chance gets an up
          vote and the bottom quarter a down vote

Each way gets the scoreboard's grade (up is right when the Buy's target came
first, down when the Sell's did, next to how often that happens anyway) and
the 10-candle move of its up calls minus its down calls, measured against
that day's average stock so the market's own move drops out.

Nothing is saved; the app's models don't change.
    docker exec trade-service python rank_check.py            (about 10 to 30 minutes)
"""
import json
import sys
from collections import defaultdict

import ml
import service

MIN_DAY = 20        # days with fewer stocks in the test aren't ranked
SHARE = 0.25        # top and bottom quarter
STEP = 10           # every 10th day for the spread's t: the 10-candle moves don't overlap


def grade(v, data, idx_up, idx_down):
    """Scoreboard grade and the day-relative move of up and down calls."""
    import numpy as np
    yb, yt, ret = data.bottom, data.top, data.ret
    known = np.isfinite(yb) & np.isfinite(yt)
    up = [i for i in idx_up if known[i]]
    down = [i for i in idx_down if known[i]]
    n = len(up) + len(down)
    hits = sum(yb[i] == 1 for i in up) + sum(yt[i] == 1 for i in down)
    k = np.flatnonzero(known)
    rb, rt = (float(yb[k].mean()), float(yt[k].mean())) if len(k) else (0.0, 0.0)
    base = (len(up) * rb + len(down) * rt) / n if n else 0.0
    return {"calls": n, "up": len(up), "down": len(down),
            "right": round(hits / n, 4) if n else 0, "anyway": round(base, 4),
            "edge": round(hits / n - base, 4) if n else 0}


def spread(data, days, picks):
    """Per day: average day-relative move of its up calls minus its down calls."""
    import numpy as np
    out = []
    for t in sorted(days):
        rows = days[t]
        mean = float(np.mean(data.ret[rows]))
        u = [data.ret[i] - mean for i in picks["up"].get(t, [])]
        d = [data.ret[i] - mean for i in picks["down"].get(t, [])]
        if u and d:
            out.append((t, float(np.mean(u)) - float(np.mean(d))))
    if not out:
        return {"days": 0}
    s = np.array([x for _, x in out])
    sparse = s[::STEP]
    t_val = float(sparse.mean() / (sparse.std(ddof=1) / np.sqrt(len(sparse)))) if len(sparse) > 2 and sparse.std(ddof=1) > 0 else 0.0
    return {"days": len(s), "move": round(float(s.mean()) * 100, 2), "daysAhead": round(float((s > 0).mean()), 3),
            "t": round(t_val, 2)}


def check(data, features):
    import numpy as np
    if len(data) > ml.MAX_ROWS:
        data = data.take(np.argsort(data.t, kind="stable")[-ml.MAX_ROWS:])
    cutoff, train, test = ml.split(data)
    first = train.labelled("first")
    _, valid = ml.valid_split(first)
    booster, best, m = ml.train_lgbm(first, features, "first")
    cal = ml.calibrate(booster.predict(valid.x, num_iteration=best))
    p = booster.predict(test.x, num_iteration=best)
    v = ml.votes_of(p, cal)

    days = defaultdict(list)
    for i, t in enumerate(test.t):
        days[int(t)].append(i)
    days = {t: rows for t, rows in days.items() if len(rows) >= MIN_DAY}
    now = {"up": defaultdict(list), "down": defaultdict(list)}
    ranked = {"up": defaultdict(list), "down": defaultdict(list)}
    one_sided = 0
    for t, rows in days.items():
        for i in rows:
            if v[i] >= ml.MIN_VOTE:
                now["up"][t].append(i)
            elif v[i] <= -ml.MIN_VOTE:
                now["down"][t].append(i)
        n_up, n_down = len(now["up"][t]), len(now["down"][t])
        if n_up + n_down and max(n_up, n_down) >= 0.9 * (n_up + n_down):
            one_sided += 1
        order = sorted(rows, key=lambda i: p[i])
        k = max(1, int(len(rows) * SHARE))
        ranked["down"][t] = order[:k]
        ranked["up"][t] = order[-k:]

    flat = lambda d: [i for rows in d.values() for i in rows]
    return {
        "testFrom": cutoff, "testDays": len(days), "stocks": len(set(test.keys.tolist())),
        "oneSidedDays": round(one_sided / len(days), 3) if days else 0,
        "now": {**grade(v, test, flat(now["up"]), flat(now["down"])), **spread(test, days, now)},
        "ranked": {**grade(v, test, flat(ranked["up"]), flat(ranked["down"])), **spread(test, days, ranked)},
    }


def show(r) -> str:
    lines = [f"Test period: {r['testDays']} days, {r['stocks']} stocks. "
             f"Days where today's votes were 90%+ one way: {r['oneSidedDays'] * 100:.0f}%", ""]
    lines.append(f"{'':8}{'calls':>7}{'up':>7}{'down':>7}{'right':>8}{'anyway':>8}{'edge':>7}   "
                 f"{'up−down move':>13}{'days ahead':>11}{'t':>6}")
    for name in ("now", "ranked"):
        g = r[name]
        lines.append(f"{name:8}{g['calls']:>7}{g['up']:>7}{g['down']:>7}{g['right'] * 100:>7.1f}%{g['anyway'] * 100:>7.1f}%"
                     f"{g['edge'] * 100:>+6.1f}   {g.get('move', 0):>+12.2f}%{g.get('daysAhead', 0) * 100:>10.0f}%{g.get('t', 0):>6.1f}")
    lines += ["", "right/anyway/edge: the scoreboard's grade. up−down move: over 10 days, up calls minus down calls,",
              "each against that day's average stock. t of 2 or more: unlikely to be luck."]
    return "\n".join(lines)


def main() -> None:
    profile = service.load_state().get("profile")
    if not profile:
        sys.exit("No profile on the server yet")
    job = {"tf": "1D", "items": service.watch_items(profile), "settings": service.engine_settings(profile),
           "kind": "stock", "total": service.TRAIN_SYMBOLS}
    header, data = ml.load_dataset(job)
    r = check(data, header["features"])
    print(show(r))
    if "--json" in sys.argv:
        print(json.dumps(r))


if __name__ == "__main__":
    main()
