import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TRADE_API_KEY"] = "secret"
os.environ["TRADE_NO_SCHEDULER"] = "1"

import service  # noqa: E402
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

KEY = {"X-API-Key": "secret"}
NY = service.NEW_YORK


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(service, "STATE_FILE", str(tmp_path / "trade.json"))
    monkeypatch.setattr(main, "API_KEY", "secret")
    yield


PROFILE = {
    "watchlist": [{"type": "crypto", "symbol": "BTC"}],
    "holdings": [
        {"id": "h1", "type": "stock", "symbol": "NVDA", "qty": 2, "buyPrice": 100, "stop": 90, "take": None},
        {"id": "h2", "type": "crypto", "symbol": "ETH", "qty": 1, "buyPrice": 3000, "stop": None, "take": None},
    ],
    "settings": {"alertTf": "15m", "quietHours": False, "riskPct": 2, "paperStart": 5000},
}


def test_watch_runs_right_after_each_candle_close():
    m = 60_000
    base = 1_800_000_000_000 - (1_800_000_000_000 % (15 * m))  # a 15-minute boundary
    assert service.candle_closed_since("15m", base - 2 * m, base + 61_000)  # the candle closed a minute ago
    assert not service.candle_closed_since("15m", base - 2 * m, base + 30_000)  # too soon: data may lag
    assert not service.candle_closed_since("15m", base + 2 * m, base + 4 * m)
    service.set_profile(PROFILE)
    st = service.load_state()
    st["watchSoonAt"] = None  # the check asked for by the new profile is tested below
    st["watch"]["lastRunAt"] = base + 2 * m
    assert not service.watch_due(st, base + 4 * m)
    assert service.watch_due(st, base + 7 * m + 1)  # 5 minutes passed (15m chart)
    st["watch"]["lastRunAt"] = base + 14 * m
    assert service.watch_due(st, base + 16 * m + 1)  # closed at +15, checked a minute after


def test_profile_keeps_risk_and_paper_start():
    p = service.set_profile(PROFILE)
    assert p["settings"]["riskPct"] == 2 and p["settings"]["paperStart"] == 5000
    p = service.set_profile({**PROFILE, "settings": {"riskPct": 99, "paperStart": "x"}})
    assert p["settings"]["riskPct"] == 5 and p["settings"]["paperStart"] == 10000


def test_market_hours_and_what_the_minute_check_covers():
    assert service.us_market_open(datetime(2026, 10, 15, 10, 0, tzinfo=NY))
    assert not service.us_market_open(datetime(2026, 10, 15, 9, 0, tzinfo=NY))
    assert not service.us_market_open(datetime(2026, 10, 17, 12, 0, tzinfo=NY))  # Saturday
    service.set_profile(PROFILE)
    service.update_state(lambda st: st.update(paper={"positions": [{"key": "crypto:SOL", "type": "crypto", "symbol": "SOL"}]}))
    st = service.load_state()
    open_ = [i["symbol"] for i in service.price_items(st, datetime(2026, 10, 15, 11, 0, tzinfo=NY))]
    closed = [i["symbol"] for i in service.price_items(st, datetime(2026, 10, 15, 20, 0, tzinfo=NY))]
    assert open_ == ["NVDA", "SOL"]  # ETH has no stop or target
    assert closed == ["SOL"]  # stocks wait for the market


def test_minute_check_alerts_and_moves_paper(monkeypatch):
    service.set_profile(PROFILE)
    service.update_state(lambda st: st.update(paper={"start": 5000, "cash": 5000, "positions": [{"key": "crypto:SOL", "type": "crypto", "symbol": "SOL"}], "trades": [], "history": []}))
    monkeypatch.setattr(service, "VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setattr(service, "VAPID_PRIVATE_KEY", "priv")
    service.add_subscription({"endpoint": "e", "keys": {}})
    sent = []
    monkeypatch.setattr(service, "_send", lambda s, p: sent.append(p["title"]) or True)
    monkeypatch.setattr(service, "us_market_open", lambda now=None: True)
    jobs = []

    def engine(job, timeout):
        jobs.append(job)
        return {"prices": {"stock:NVDA": 88.0, "crypto:SOL": 150.0}, "alerts": [{"kind": "stop", "key": "stock:NVDA", "urgent": True, "title": "Stop-loss hit: NVDA", "body": ""}],
                "holdingsAlerted": {"h1": {"stop": True}}, "paper": {**job["paper"], "positions": [], "cash": 5100},
                "paperEvents": [{"kind": "close", "text": "Sold SOL"}], "errors": {}}

    service.run_prices(engine=engine)
    assert jobs[0]["mode"] == "prices" and [i["symbol"] for i in jobs[0]["items"]] == ["NVDA", "SOL"]
    assert sent == ["Stop-loss hit: NVDA"]
    st = service.load_state()
    assert st["profile"]["holdings"][0]["alerted"] == {"stop": True}
    assert st["paper"]["cash"] == 5100 and st["paperEvents"][0]["text"] == "Sold SOL"
    assert st["prices"]["values"]["stock:NVDA"] == 88.0
    assert not service.prices_due(st, service.now_ms()) and service.prices_due(st, service.now_ms() + 61_000)


def test_paper_reset_and_hourly_scans():
    service.set_profile(PROFILE)
    c = TestClient(main.app)
    acc = c.post("/paper/reset", json={}, headers=KEY).json()["paper"]
    assert acc["start"] == 5000 and acc["cash"] == 5000 and acc["positions"] == []
    assert c.post("/paper/reset", json={"start": 25000}, headers=KEY).json()["paper"]["start"] == 25000
    assert c.post("/paper/reset", json={"start": 5}, headers=KEY).status_code == 400
    assert c.get("/paper").status_code == 401
    times = service.scan_times()
    assert len([t for t in times if "10:00" <= t <= "16:00"]) == 12  # every 30 minutes while the market is open


def test_a_change_gets_checked_within_a_minute(monkeypatch):
    now = [1_800_000_000_000]
    monkeypatch.setattr(service, "now_ms", lambda: now[0])
    service.set_profile(PROFILE)
    st = service.load_state()
    assert st["watchSoonAt"] == now[0] + service.WATCH_SOON_MS
    st["watch"]["lastRunAt"] = now[0]
    assert not service.watch_due(st, now[0] + 10_000)
    assert service.watch_due(st, now[0] + service.WATCH_SOON_MS)
    # Saving the same profile again (or only quiet hours) asks for nothing new.
    service.update_state(lambda s: s.update(watchSoonAt=None))
    service.set_profile({**PROFILE, "settings": {**PROFILE["settings"], "quietHours": True}})
    assert service.load_state()["watchSoonAt"] is None
    service.set_profile({**PROFILE, "settings": {**PROFILE["settings"], "tune": "manual"}})
    assert service.load_state()["watchSoonAt"] == now[0] + service.WATCH_SOON_MS

    # A run clears the ask, unless a newer change came in while it ran.
    def engine(job, timeout):
        return {"signals": {}, "alerts": [], "weights": {}, "holdingsAlerted": {}, "errors": {}, "paper": None, "paperEvents": []}
    now[0] += service.WATCH_SOON_MS
    service.run_watch(engine=engine)
    assert service.load_state()["watchSoonAt"] is None


def test_profile_tuning_settings_and_training_every_timeframe():
    p = service.set_profile(PROFILE)
    assert p["settings"]["tune"] == "auto" and p["settings"]["mode"] == "standard"
    p = service.set_profile({**PROFILE, "settings": {**PROFILE["settings"], "tune": "manual", "mode": "dip"}})
    assert p["settings"]["tune"] == "manual" and p["settings"]["mode"] == "dip"
    assert service.engine_settings(p)["mode"] == "dip"
    assert service.train_timeframes(p) == ["15m", "1D", "1W", "1h"]
    p["settings"]["alertTf"] = "1h"
    assert service.train_timeframes(p) == ["1h", "1D", "15m", "1W"]
