import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TRADE_API_KEY"] = "secret"
os.environ["TRADE_NO_SCHEDULER"] = "1"

import service  # noqa: E402
import scoreboard  # noqa: E402
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

KEY = {"X-API-Key": "secret"}
DAY = 86_400
T0 = 1_760_000_000          # a candle time (seconds)
NOW = (T0 + 20 * DAY) * 1000
VOTERS = {"rsi": ["RSI", "momentum"], "macd": ["MACD", "momentum"], "lgbm": ["LightGBM", "ml"]}


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(service, "STATE_FILE", str(tmp_path / "trade.json"))
    monkeypatch.setattr(main, "API_KEY", "secret")
    yield


def obs(key, i, price, a="hold", up=(), down=(), f=None, kind="stock"):
    o = {"key": key, "type": kind, "tf": "1D", "t": T0 + i * DAY, "p": price, "a": a, "up": list(up), "down": list(down)}
    if f is not None:
        o["f"] = f
    return o


def run_days(days, now=NOW):
    """days: list of per-day observation lists, recorded one run per day."""
    graded = 0
    for day in days:
        graded += scoreboard.record(day, VOTERS, now=now)
    return graded


def test_a_call_is_graded_after_ten_more_candles_have_closed():
    # AAA rises 1% a day, BBB stays flat: the market's average move is half AAA's.
    days = [[obs("stock:AAA", i, 100 * 1.01 ** i, a="buy" if i == 0 else "hold", up=["rsi"] if i == 0 else [], f=1.2 if i == 0 else None),
             obs("stock:BBB", i, 50, a="sell" if i == 0 else "hold", down=["macd", "g:momentum"] if i == 0 else [])]
            for i in range(11)]
    assert run_days(days) == 0, "the 10th candle after the call is still forming"
    assert run_days([[obs("stock:AAA", 11, 200), obs("stock:BBB", 11, 50)]]) == 2

    s = scoreboard.summary("all", None, now=NOW)
    buy, sell = s["calls"]
    assert buy["n"] == 1 and sell["n"] == 1
    assert "right" not in buy, "under 30 calls there is a count but no score"

    board = scoreboard.load()
    ret = 1.01 ** 10 - 1
    b = board["recent"]["buy"][0]
    assert b["right"] and abs(b["r"] - (ret - 0.002)) < 1e-4
    # The Sell on a flat chart avoided nothing: not right.
    assert board["recent"]["sell"][0]["right"] is False
    day = board["days"][scoreboard._day(T0)]["stock"]
    assert abs(day["buy"][3] - ret / 2) < 1e-4, "vs hold: AAA's move against the average of AAA and BBB"
    assert day["sell"][3] == pytest.approx(ret / 2, abs=1e-4), "BBB fell behind the market by as much"
    assert day["v:rsi"][0] == 1 and day["v:macd"][0] == 1 and day["v:g:momentum"][0] == 1
    assert day["f:bigger"][0] == 1
    assert board["pending"] == {}


def test_scores_show_from_thirty_calls_and_split_by_kind():
    days = []
    for i in range(12):
        row = []
        for n in range(30):
            row.append(obs(f"stock:S{n}", i, 100 + i, a="buy" if i == 0 else "hold", up=["lgbm"] if i == 0 else []))
        row.append(obs("crypto:BTC", i, 100 - i, a="buy" if i == 0 else "hold", kind="crypto", f=0 if i == 0 else None))
        days.append(row)
    run_days(days)
    stocks = scoreboard.summary("stock", None, now=NOW)
    assert stocks["calls"][0]["n"] == 30 and stocks["calls"][0]["right"] == 1
    assert stocks["ml"] == [{"id": "v:lgbm", "label": "LightGBM", "n": 30, "right": 1.0, "avg": pytest.approx(0.098, abs=1e-3), "edge": 0.0}]
    momentum = next(g for g in stocks["groups"] if g["id"] == "v:g:momentum")
    assert [m["label"] for m in momentum["methods"]] == ["MACD", "RSI"]
    crypto = scoreboard.summary("crypto", None, now=NOW)
    assert crypto["calls"][0]["n"] == 1
    assert crypto["filter"][2]["n"] == 1, "the Buy the filter blocked"
    assert scoreboard.recent("buy", "crypto")[0]["key"] == "crypto:BTC"


def test_old_days_drop_out_of_the_window():
    days = [[obs("stock:AAA", i, 100 + i, a="buy" if i == 0 else "hold")] for i in range(12)]
    run_days(days)
    later = (T0 + 60 * DAY) * 1000
    assert scoreboard.summary("all", 30, now=later)["calls"][0]["n"] == 0
    assert scoreboard.summary("all", 90, now=later)["calls"][0]["n"] == 1


def test_a_forming_candle_keeps_its_latest_read():
    scoreboard.record([obs("stock:AAA", 0, 100, a="buy")], VOTERS, now=NOW)
    scoreboard.record([obs("stock:AAA", 0, 101, a="hold")], VOTERS, now=NOW)
    board = scoreboard.load()
    assert board["prices"]["stock:AAA:1D"] == [[T0, 101]]
    assert board["pending"] == {}, "the Buy was dropped before the candle closed, and a hold with no firm votes is not graded"


def test_the_endpoints(client=None):
    client = TestClient(main.app)
    assert client.get("/scoreboard", headers=KEY).json()["calls"][0] == {"id": "buy", "label": "Buy", "n": 0}
    assert client.get("/scoreboard?kind=bonds", headers=KEY).status_code == 400
    assert client.get("/scoreboard/calls?source=buy", headers=KEY).json() == {"source": "buy", "calls": []}
    assert client.get("/scoreboard").status_code == 401


def test_runs_hand_their_observations_to_the_scoreboard_and_not_to_the_app():
    result = {"observations": [obs("stock:AAA", 0, 100, a="buy")], "voters": VOTERS, "buys": []}
    service.keep_score(result)
    assert "observations" not in result and "voters" not in result
    assert scoreboard.load()["pending"]
