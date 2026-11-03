import json
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


def obs(key, i, price, a="hold", up=(), down=(), f=None, kind="stock", high=None, low=None, atr=1.0):
    o = {"key": key, "type": kind, "tf": "1D", "t": T0 + i * DAY, "p": price, "h": price if high is None else high,
         "l": price if low is None else low, "atr": atr, "sa": 2, "ta": 3, "a": a, "up": list(up), "down": list(down)}
    if f is not None:
        o["f"] = f
    return o


def run_days(days, now=NOW):
    """days: list of per-day observation lists, recorded one run per day."""
    graded = 0
    for day in days:
        graded += scoreboard.record(day, VOTERS, now=now)
    return graded


@pytest.fixture
def short_cap(monkeypatch):
    monkeypatch.setattr(scoreboard, "CAP", 5)


def test_a_buy_is_right_when_its_target_comes_before_its_stop():
    # Day 0: Buy at 100, ATR 1: stop 98, target 103. AAA climbs 1 a day and
    # touches 103 on day 3; BBB stays flat.
    days = [[obs("stock:AAA", i, 100 + i, a="buy" if i == 0 else "hold", up=["rsi"] if i == 0 else [], f=1.2 if i == 0 else None),
             obs("stock:BBB", i, 50)] for i in range(4)]
    assert run_days(days) == 0, "day 3 touched the target but is still forming"
    assert run_days([[obs("stock:AAA", 4, 104), obs("stock:BBB", 4, 50)]]) == 1

    board = scoreboard.load()
    b = board["recent"]["buy"][0]
    assert (b["how"], b["candles"], b["right"]) == ("target", 3, True)
    assert b["r"] == pytest.approx(0.03 - 0.002)
    day = board["days"][scoreboard._day(T0)]["stock"]
    assert day["buy"][3] == pytest.approx(0.03 - 0.015), "vs hold: the 3% exit against the average of AAA (+3%) and BBB (0%)"
    assert day["v:rsi"][0] == 1 and day["f:bigger"][0] == 1
    assert board["pending"] == {}


def test_the_stop_and_the_cap(short_cap):
    days = [[obs("stock:DOWN", i, 100 - i, a="buy" if i == 0 else "hold", low=100 - i - 0.5),
             obs("stock:FLAT", i, 50, a="sell" if i == 0 else "hold", down=["macd", "g:momentum"] if i == 0 else []),
             obs("stock:BOTH", i, 100, a="buy" if i == 0 else "hold", high=104 if i == 1 else 100, low=97 if i == 1 else 100)]
            for i in range(7)]
    run_days(days)
    board = scoreboard.load()
    down = next(r for r in board["recent"]["buy"] if r["key"] == "stock:DOWN")
    assert (down["how"], down["candles"], down["right"]) == ("stop", 2, False)
    assert down["ret"] == pytest.approx(-0.02), "sold at the stop, 2 ATR down"
    both = next(r for r in board["recent"]["buy"] if r["key"] == "stock:BOTH")
    assert (both["how"], both["right"]) == ("stop", False), "a candle touching both counts as the stop"
    flat = board["recent"]["sell"][0]
    assert (flat["how"], flat["candles"], flat["right"]) == ("cap", 5, False), "neither level in 5 candles: the flat move decides"
    assert board["days"][scoreboard._day(T0)]["stock"]["v:g:momentum"][0] == 1


def test_scores_show_from_thirty_calls_and_split_by_kind():
    days = []
    for i in range(5):
        row = []
        for n in range(30):
            row.append(obs(f"stock:S{n}", i, 100 + i, a="buy" if i == 0 else "hold", up=["lgbm"] if i == 0 else []))
        row.append(obs("crypto:BTC", i, 100 - i, a="buy" if i == 0 else "hold", kind="crypto", f=0 if i == 0 else None))
        days.append(row)
    run_days(days)
    stocks = scoreboard.summary("stock", None, now=NOW)
    assert stocks["calls"][0]["n"] == 30 and stocks["calls"][0]["right"] == 1
    assert stocks["ml"] == [{"id": "v:lgbm", "label": "LightGBM (old)", "n": 30, "right": 1.0, "avg": pytest.approx(0.028), "edge": 0.0}]
    assert scoreboard.summary("crypto", None, now=NOW)["ml"] == [], "the old mixed models show only with graded calls"
    momentum = next(g for g in stocks["groups"] if g["id"] == "v:g:momentum")
    assert [m["label"] for m in momentum["methods"]] == ["MACD", "RSI"]
    assert "right" not in scoreboard.summary("crypto", None, now=NOW)["calls"][0], "under 30 calls: a count, no score"
    crypto = scoreboard.summary("crypto", None, now=NOW)
    assert crypto["calls"][0]["n"] == 1
    assert crypto["filter"][2]["n"] == 1, "the Buy the filter blocked"
    assert scoreboard.recent("buy", "crypto")[0]["key"] == "crypto:BTC"


def test_old_days_drop_out_of_the_window():
    days = [[obs("stock:AAA", i, 100 + i, a="buy" if i == 0 else "hold")] for i in range(5)]
    run_days(days)
    later = (T0 + 60 * DAY) * 1000
    assert scoreboard.summary("all", 30, now=later)["calls"][0]["n"] == 0
    assert scoreboard.summary("all", 90, now=later)["calls"][0]["n"] == 1


def test_a_forming_candle_keeps_its_latest_read():
    scoreboard.record([obs("stock:AAA", 0, 100, a="buy")], VOTERS, now=NOW)
    scoreboard.record([obs("stock:AAA", 0, 101, a="hold")], VOTERS, now=NOW)
    board = scoreboard.load()
    assert board["prices"]["stock:AAA:1D"] == [[T0, 101, 101, 101]]
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


def test_the_docker_image_gets_every_server_module():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(here, "Dockerfile"), encoding="utf-8") as f:
        copied = " ".join(line for line in f if line.startswith("COPY "))
    modules = [n for n in os.listdir(here) if n.endswith((".py", ".mjs"))]
    assert [n for n in modules if n not in copied.split()] == []


def test_calls_recorded_by_the_first_version_are_dropped():
    with open(scoreboard.path(), "w", encoding="utf-8") as f:
        json.dump({"prices": {"stock:AAA:1D": [[T0, 100]]}, "pending": {"stock:AAA:1D:1": {"key": "stock:AAA", "tf": "1D", "t": T0, "a": "buy", "up": [], "down": []}}}, f)
    scoreboard.record([obs("stock:AAA", 1, 101)], VOTERS, now=NOW)
    board = scoreboard.load()
    assert board["pending"] == {} and board["prices"]["stock:AAA:1D"][-1] == [T0 + DAY, 101, 101, 101]


def test_each_side_is_graded_when_its_own_level_is_reached():
    # A Buy with RSI leaning up and MACD leaning down, ATR 1, climbing 1 a day:
    # the down side's stop (102) is hit on day 2, the up side's target (103) on day 3.
    days = [[obs("stock:AAA", i, 100 + i, a="buy" if i == 0 else "hold", up=["rsi"] if i == 0 else [], down=["macd"] if i == 0 else [])]
            for i in range(5)]
    run_days(days)
    board = scoreboard.load()
    assert board["pending"] == {}
    day = board["days"][scoreboard._day(T0)]["stock"]
    assert day["buy"][:2] == [1, 1] and day["v:rsi"][:2] == [1, 1] and day["v:macd"][:2] == [1, 0]


def test_the_up_side_does_not_wait_for_the_down_side():
    # Buy at 100, ATR 1. Day 1 dips to 97.5: the up side's stop (98) is hit, the
    # down side's target (97) and stop (102) are not, so only the up side is graded.
    days = [[obs("stock:AAA", 0, 100, a="buy", up=["rsi"], down=["macd"])],
            [obs("stock:AAA", 1, 99, low=97.5)],
            [obs("stock:AAA", 2, 99.5)]]
    run_days(days)
    board = scoreboard.load()
    day = board["days"][scoreboard._day(T0)]["stock"]
    assert day["buy"][:2] == [1, 0] and day["v:rsi"][:2] == [1, 0] and "v:macd" not in day
    assert list(board["pending"].values())[0]["done"] == [1], "the down side still waits"
    run_days([[obs("stock:AAA", 3, 96.5, low=96.5)], [obs("stock:AAA", 4, 97)]])
    board = scoreboard.load()
    assert board["pending"] == {} and board["days"][scoreboard._day(T0)]["stock"]["v:macd"][:2] == [1, 1]
    assert board["days"][scoreboard._day(T0)]["stock"]["buy"][0] == 1, "the Buy is graded once"
