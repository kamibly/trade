import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ["TRADE_NO_SCHEDULER"] = "1"

import numpy as np  # noqa: E402

import ml  # noqa: E402
import rank_check  # noqa: E402


def _data(stocks=40, days=500, seed=1):
    """Stocks whose first feature predicts how they do against the others."""
    rng = np.random.default_rng(seed)
    keys, t, x, ret = [], [], [], []
    market = rng.normal(0, 0.02, days)
    for s in range(stocks):
        for d in range(days):
            f = rng.normal(size=3)
            keys.append(f"stock:S{s}")
            t.append(86400 * d)
            x.append(f)
            ret.append(market[d] + 0.01 * f[0] + rng.normal(0, 0.03))
    ret = np.array(ret)
    yb, yt = (ret > 0.02).astype(np.float32), (ret < -0.02).astype(np.float32)
    n = len(t)
    return ml.Data(np.array(keys, dtype=object), np.array(t), np.array(x), np.zeros((n, 1, 2), np.float32),
                   np.zeros(n, np.float32), ret, yb, yt)


def test_ranking_gives_each_day_both_sides_and_finds_the_edge():
    r = rank_check.check(_data(), ["a", "b", "c"])
    ranked = r["ranked"]
    assert ranked["up"] == ranked["down"] > 0
    assert ranked["move"] > 0 and ranked["t"] >= 2
    assert "Test period" in rank_check.show(r)
