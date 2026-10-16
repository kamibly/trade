"""
Weekly machine-learning training for trade-service.

Four models per timeframe. Two predict whether the price is up by more than
the round-trip fee 10 candles later:

- LightGBM (gradient-boosted trees) on the 30 method votes plus a few
  indicator features;
- a small LSTM neural network on the last 32 candles' moves and volume.

Two more LightGBM models find turning points: "bottom" learns whether a buy
here reaches its target before its stop (the app's stop and target, in ATRs),
"top" whether the price falls to a target before rising to a stop. They must
beat how often that happens anyway by TURN_EDGE to vote.

The data comes from engine.mjs (mode "dataset"), so the features are computed
by the same JavaScript the phone runs. Rows are split by time: the oldest ~70%
trains the models and the newest ~30% tests them. The saved models are the
ones trained before that cutoff, and the app only lets them vote on candles
after it, so every score they get is out of sample. A model whose test hit
rate isn't above 50% (on at least 200 clear calls) is saved but doesn't vote.

Runs as its own process so the large libraries leave memory when it ends:
    python ml.py < job.json        job: {tf, items, settings, total}
It writes DATA_DIR/models/<tf>.json and prints a short summary as JSON.
"""
import json
import math
import os
import subprocess
import sys
import threading
import time
from collections import defaultdict
from typing import List, Optional

import service

HORIZON = 10
TURN_HORIZON = 30         # candles the turning-point labels look ahead (app/js/ml.js)
TURN_EDGE = 0.03
TURN_MODELS = ("bottom", "top")
FEE = 0.001
MIN_VOTE = 0.3            # the backtest's "clear opinion": |vote| >= 0.3
MIN_HIT, MIN_N = 0.5, 200
TEST_SHARE = 0.3
MIN_TRAIN_ROWS, MIN_TEST_ROWS = 1000, 300
MAX_ROWS = 150_000        # keeps training inside the VM's memory
SEED = 7


def models_dir() -> str:
    return os.path.join(service.DATA_DIR, "models")


def models_path(tf: str) -> str:
    return os.path.join(models_dir(), f"{tf}.json")


def load_models(tf: str) -> Optional[dict]:
    try:
        with open(models_path(tf), "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return None


def save_models(tf: str, models: dict) -> None:
    os.makedirs(models_dir(), exist_ok=True)
    tmp = models_path(tf) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(models, f, separators=(",", ":"))
    os.replace(tmp, models_path(tf))


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

class Data:
    """Engine rows as compact arrays (lists of dicts would need several times the memory)."""

    def __init__(self, keys, t, x, seq, y, ret, yb=None, yt=None):
        import numpy as np
        self.keys, self.t, self.x, self.seq, self.y, self.ret = keys, t, x, seq, y, ret
        # Turning-point labels; NaN where the outcome isn't known yet.
        nan = lambda: np.full(len(t), np.nan, dtype=np.float32)
        self.bottom = yb if yb is not None else nan()
        self.top = yt if yt is not None else nan()

    def __len__(self):
        return len(self.t)

    def take(self, idx) -> "Data":
        return Data(self.keys[idx], self.t[idx], self.x[idx], self.seq[idx], self.y[idx], self.ret[idx],
                    self.bottom[idx], self.top[idx])

    def labelled(self, target: str) -> "Data":
        """Only the rows whose `target` label is known."""
        import numpy as np
        return self.take(np.flatnonzero(np.isfinite(getattr(self, target))))


def to_data(rows) -> Data:
    """Builds the arrays from an iterable of engine rows, one row at a time."""
    import numpy as np
    keys, t, x, seq, y, ret, yb, yt = [], [], [], [], [], [], [], []
    num = lambda v: math.nan if v is None else v
    for r in rows:
        keys.append(r["key"])
        t.append(r["t"])
        x.append(np.array([num(v) for v in r["x"]], dtype=np.float64))
        seq.append(np.array(r["seq"], dtype=np.float32))
        y.append(r["y"])
        ret.append(r["ret"])
        yb.append(num(r.get("yb")))
        yt.append(num(r.get("yt")))
    if not t:
        return Data(np.array([], dtype=object), np.array([], dtype=np.int64), np.zeros((0, 0)), np.zeros((0, 0, 2), dtype=np.float32), np.array([], dtype=np.float32), np.array([]))
    return Data(np.array(keys, dtype=object), np.array(t, dtype=np.int64), np.stack(x), np.stack(seq),
                np.array(y, dtype=np.float32), np.array(ret, dtype=np.float64),
                np.array(yb, dtype=np.float32), np.array(yt, dtype=np.float32))


def load_dataset(job: dict, timeout: int = 3000):
    """Runs the engine's dataset mode and reads its rows as they stream in."""
    proc = subprocess.Popen([service.NODE, service.ENGINE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    timer = threading.Timer(timeout, proc.kill)
    timer.start()
    try:
        proc.stdin.write(json.dumps({**job, "mode": "dataset", "stream": True}))
        proc.stdin.close()
        header = json.loads(proc.stdout.readline() or "null")
        data = to_data(json.loads(line) for line in proc.stdout if line.strip())
        err = proc.stderr.read()
        if proc.wait() != 0 or not header:
            raise RuntimeError((err or "engine failed").strip().splitlines()[-1][:300])
    finally:
        timer.cancel()
    return header, data


# ---------------------------------------------------------------------------
# Splitting
# ---------------------------------------------------------------------------

def split(data: Data):
    """Train and test rows by a time cutoff shared by every symbol.

    The last TURN_HORIZON train rows of each symbol are dropped: their labels
    look past the cutoff, into the test period.
    """
    import numpy as np
    times = np.sort(data.t)
    cutoff = int(times[min(len(times) - 1, int(len(times) * (1 - TEST_SHARE)))])
    before = np.flatnonzero(data.t <= cutoff)
    by_key = defaultdict(list)
    for i in before:
        by_key[data.keys[i]].append(i)
    train = []
    for idx in by_key.values():
        idx.sort(key=lambda i: data.t[i])
        train.extend(idx[:-TURN_HORIZON])
    train = np.array(sorted(train, key=lambda i: data.t[i]), dtype=np.int64)
    test = np.flatnonzero(data.t > cutoff)
    return cutoff, data.take(train), data.take(test)


def valid_split(train: Data):
    """The newest 15% of the training rows checks when to stop training."""
    import numpy as np
    k = int(len(train) * 0.85)
    return train.take(np.arange(k)), train.take(np.arange(k, len(train)))


def calibrate(probs) -> dict:
    """Where a model's predictions usually sit and how far they spread.

    On real prices the models rarely stray far from the base rate (often about
    45% "up after fees"), so a fixed 50% midpoint would make almost every call
    "down" and none of them clear. The vote is measured from the model's own
    middle instead: vote = (p - center) / scale, with the boldest 10% of
    predictions at full strength. Set on training-period data only.
    """
    import numpy as np
    p = np.asarray(probs, dtype=np.float64)
    center = float(np.median(p))
    scale = float(np.quantile(np.abs(p - center), 0.9))
    return {"center": round(center, 6), "scale": round(max(scale, 1e-4), 6)}


def votes_of(probs, cal: dict):
    import numpy as np
    return np.clip((np.asarray(probs, dtype=np.float64) - cal["center"]) / cal["scale"], -1, 1)


def hit_rate(probs, ret, cal: Optional[dict] = None) -> dict:
    """Like the backtest: clear votes only, right when the move beats the fees."""
    import numpy as np
    cal = cal or {"center": 0.5, "scale": 0.25}
    v, ret = votes_of(probs, cal), np.asarray(ret, dtype=np.float64)
    clear = np.abs(v) >= MIN_VOTE
    right = ((v > 0) & (ret > 2 * FEE)) | ((v < 0) & (ret < -2 * FEE))
    n = int(clear.sum())
    hits = int((clear & right).sum())
    up = float((ret > 2 * FEE).mean()) if len(ret) else 0.0
    return {"hit": round(hits / n, 4) if n else 0, "n": n, "rows": int(len(ret)), "upShare": round(up, 4)}


# Vote ranges for the outcome table: strong down, down, neutral, up, strong up.
BINS = [-1.0, -0.6, -0.2, 0.2, 0.6, 1.0]


def outcomes(probs, ret, cal: dict) -> List[dict]:
    """What actually happened in the test period after each range of votes.

    The chart's ML line uses it: for today's vote it draws the average move
    that followed similar votes, and the share of those that rose after fees.
    """
    import numpy as np
    v, ret = votes_of(probs, cal), np.asarray(ret, dtype=np.float64)
    out = []
    for k, (lo, hi) in enumerate(zip(BINS, BINS[1:])):
        inside = (v >= lo) & ((v < hi) if k < len(BINS) - 2 else (v <= hi))
        r = ret[inside]
        out.append({"lo": lo, "hi": hi, "n": int(len(r)),
                    "ret": round(float(r.mean()), 5) if len(r) else 0,
                    "up": round(float((r > 2 * FEE).mean()), 4) if len(r) else 0})
    return out


def usable(test: dict) -> bool:
    if "base" in test:
        return test["n"] >= MIN_N and test["hit"] >= test["base"] + TURN_EDGE
    return test["hit"] > MIN_HIT and test["n"] >= MIN_N


def turn_test(probs, labels, cal: dict) -> dict:
    """A turning-point model's clear calls (vote >= 0.3): how often the outcome
    followed (hit), next to how often it happens anyway (base)."""
    import numpy as np
    v, labels = votes_of(probs, cal), np.asarray(labels, dtype=np.float64)
    clear = v >= MIN_VOTE
    n = int(clear.sum())
    return {"hit": round(float(labels[clear].mean()), 4) if n else 0, "n": n, "rows": int(len(labels)),
            "base": round(float(labels.mean()), 4) if len(labels) else 0}


# ---------------------------------------------------------------------------
# LightGBM
# ---------------------------------------------------------------------------

MISSING = {"None": 0, "Zero": 1, "NaN": 2}


def export_tree(structure: dict) -> dict:
    """LightGBM's nested tree as flat lists app/js/ml.js walks."""
    if "split_index" not in structure:
        return {"nodes": [], "leaves": [structure["leaf_value"]]}
    nodes, leaves = [], {}

    def walk(node) -> int:
        if "split_index" not in node:
            leaves[node["leaf_index"]] = round(node["leaf_value"], 7)
            return -node["leaf_index"] - 1
        if node.get("decision_type", "<=") != "<=":
            raise ValueError("Only numeric splits are supported")
        i = len(nodes)
        nodes.append(None)
        left = walk(node["left_child"])
        right = walk(node["right_child"])
        nodes[i] = [node["split_feature"], node["threshold"], left, right,
                    1 if node["default_left"] else 0, MISSING[node.get("missing_type", "None")]]
        return i

    walk(structure)
    return {"nodes": nodes, "leaves": [leaves[k] for k in range(len(leaves))]}


def export_lgbm(booster, features: List[str], num_iteration: int) -> dict:
    dump = booster.dump_model(num_iteration=num_iteration)
    return {"init": 0, "features": features, "trees": [export_tree(t["tree_structure"]) for t in dump["tree_info"]]}


def train_lgbm(train: Data, features: List[str], target: str = "y"):
    import lightgbm as lgb
    fit, valid = valid_split(train)
    params = {
        "objective": "binary", "learning_rate": 0.05, "num_leaves": 15, "min_data_in_leaf": 100,
        "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1, "lambda_l2": 1.0,
        "verbose": -1, "seed": SEED, "num_threads": 2,
    }
    dfit = lgb.Dataset(fit.x, label=getattr(fit, target))
    dvalid = lgb.Dataset(valid.x, label=getattr(valid, target), reference=dfit)
    booster = lgb.train(params, dfit, num_boost_round=300, valid_sets=[dvalid],
                        callbacks=[lgb.early_stopping(30, verbose=False)])
    best = booster.best_iteration or booster.current_iteration()
    return booster, best, export_lgbm(booster, features, best)


# ---------------------------------------------------------------------------
# LSTM
# ---------------------------------------------------------------------------

HIDDEN = 16


def _lstm_net():
    import torch

    class Net(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.lstm = torch.nn.LSTM(input_size=2, hidden_size=HIDDEN, batch_first=True)
            self.out = torch.nn.Linear(HIDDEN, 1)

        def forward(self, x):
            _, (h, _) = self.lstm(x)
            return self.out(h[-1]).squeeze(-1)

    return Net()


def lstm_probs(net, seq) -> List[float]:
    import torch
    net.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(seq), 2048):
            out.extend(torch.sigmoid(net(torch.from_numpy(seq[i:i + 2048]))).tolist())
    return out


def export_lstm(net) -> dict:
    r = lambda t: [[round(v, 7) for v in row] for row in t.tolist()]
    v = lambda t: [round(x, 7) for x in t.tolist()]
    sd = net.state_dict()
    return {
        "hidden": HIDDEN,
        "wIh": r(sd["lstm.weight_ih_l0"]), "wHh": r(sd["lstm.weight_hh_l0"]),
        "bIh": v(sd["lstm.bias_ih_l0"]), "bHh": v(sd["lstm.bias_hh_l0"]),
        "wOut": v(sd["out.weight"][0]), "bOut": round(sd["out.bias"].item(), 7),
    }


def train_lstm(train: Data, epochs: int = 15):
    import torch
    torch.manual_seed(SEED)
    torch.set_num_threads(2)
    fit, valid = valid_split(train)
    net = _lstm_net()
    opt = torch.optim.Adam(net.parameters(), lr=2e-3)
    loss_fn = torch.nn.BCEWithLogitsLoss()
    x, y = torch.from_numpy(fit.seq), torch.from_numpy(fit.y)
    xv, yv = torch.from_numpy(valid.seq), torch.from_numpy(valid.y)
    best, best_state, patience = math.inf, None, 0
    g = torch.Generator().manual_seed(SEED)
    for _ in range(epochs):
        net.train()
        order = torch.randperm(len(x), generator=g)
        for i in range(0, len(x), 256):
            idx = order[i:i + 256]
            opt.zero_grad()
            loss = loss_fn(net(x[idx]), y[idx])
            loss.backward()
            opt.step()
        net.eval()
        with torch.no_grad():
            vl = loss_fn(net(xv), yv).item()
        if vl < best - 1e-4:
            best, patience = vl, 0
            best_state = {k: t.clone() for k, t in net.state_dict().items()}
        else:
            patience += 1
            if patience >= 3:
                break
    if best_state:
        net.load_state_dict(best_state)
    return net, export_lstm(net)


# ---------------------------------------------------------------------------
# Whole run
# ---------------------------------------------------------------------------

def train_models(data: Data, features: List[str], tf: str, symbols: Optional[int] = None, now: Optional[int] = None,
                 stop_atr: float = 2, take_atr: float = 3) -> dict:
    """Trains the four models and returns what's saved."""
    import numpy as np
    if not len(data):
        raise ValueError("No training data (no charts could be loaded)")
    if len(data) > MAX_ROWS:
        data = data.take(np.argsort(data.t, kind="stable")[-MAX_ROWS:])
    cutoff, train, test = split(data)
    if len(train) < MIN_TRAIN_ROWS or len(test) < MIN_TEST_ROWS:
        raise ValueError(f"Not enough history to train: {len(train)} training and {len(test)} test rows")

    _, valid = valid_split(train)
    booster, best, lgbm = train_lgbm(train, features)
    lgbm.update(calibrate(booster.predict(valid.x, num_iteration=best)))
    p_test = booster.predict(test.x, num_iteration=best)
    lgbm["test"] = hit_rate(p_test, test.ret, lgbm)
    lgbm["outcomes"] = outcomes(p_test, test.ret, lgbm)
    del booster

    net, lstm = train_lstm(train)
    lstm.update(calibrate(lstm_probs(net, valid.seq)))
    p_test = lstm_probs(net, test.seq)
    lstm["test"] = hit_rate(p_test, test.ret, lstm)
    lstm["outcomes"] = outcomes(p_test, test.ret, lstm)

    turns = {}
    for name in TURN_MODELS:
        tr, te = train.labelled(name), test.labelled(name)
        if len(tr) < MIN_TRAIN_ROWS or len(te) < MIN_TEST_ROWS:
            continue
        _, tvalid = valid_split(tr)
        booster, best, m = train_lgbm(tr, features, name)
        m.update(calibrate(booster.predict(tvalid.x, num_iteration=best)))
        m["test"] = turn_test(booster.predict(te.x, num_iteration=best), getattr(te, name), m)
        m.update({"stopAtr": stop_atr, "takeAtr": take_atr})
        turns[name] = m
        del booster

    for m in (lgbm, lstm, *turns.values()):
        m["test"]["usable"] = usable(m["test"])
    return {
        "tf": tf,
        "cutoff": cutoff,
        "trainedAt": now or service.now_ms(),
        "symbols": symbols if symbols is not None else len(set(data.keys.tolist())),
        "trainRows": len(train),
        "testRows": len(test),
        "lgbm": lgbm,
        "lstm": lstm,
        **turns,
    }


def summary(models: Optional[dict]) -> Optional[dict]:
    """The small part the app and /status show; no weights."""
    if not models:
        return None
    keep = ("tf", "cutoff", "trainedAt", "symbols", "trainRows", "testRows")
    out = {k: models.get(k) for k in keep}
    for name in ("lgbm", "lstm", *TURN_MODELS):
        out[name] = (models.get(name) or {}).get("test")
    return out


def main() -> None:
    job = json.load(sys.stdin)
    started = time.time()
    header, data = load_dataset(job)
    settings = job.get("settings") or {}
    models = train_models(data, header["features"], job["tf"], header.get("symbols"),
                          stop_atr=settings.get("stopAtr", 2), take_atr=settings.get("takeAtr", 3))
    save_models(job["tf"], models)
    out = summary(models)
    out["seconds"] = round(time.time() - started)
    out["chartErrors"] = len(header.get("errors") or {})
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
