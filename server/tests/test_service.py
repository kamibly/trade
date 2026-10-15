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


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(service, "STATE_FILE", str(tmp_path / "trade.json"))
    monkeypatch.setattr(main, "API_KEY", "secret")
    yield


@pytest.fixture
def client():
    return TestClient(main.app)


PROFILE = {
    "watchlist": [{"type": "stock", "symbol": "aapl", "name": "Apple"}, {"type": "crypto", "symbol": "BTC", "geckoId": "bitcoin"}, {"type": "bond", "symbol": "X"}],
    "holdings": [
        {"id": "h1", "type": "stock", "symbol": "NVDA", "qty": 2, "buyPrice": 100, "stop": 90, "take": None},
        {"id": "bad", "type": "stock", "symbol": "MSFT", "qty": 0, "buyPrice": 100},
    ],
    "settings": {"alertTf": "1h", "buyAt": 500, "sellAt": -30, "quietHours": False},
    "updatedAt": 123,
}


def test_key_required(client):
    assert client.get("/status").status_code == 401
    assert client.get("/status", headers={"X-API-Key": "nope"}).status_code == 401
    assert client.get("/health").json()["status"] == "ok"


def test_sync_cleans_and_keeps_alerts(client):
    r = client.put("/sync", json=PROFILE, headers=KEY).json()["profile"]
    assert [i["symbol"] for i in r["watchlist"]] == ["AAPL", "BTC"]
    assert [h["id"] for h in r["holdings"]] == ["h1"]
    assert r["holdings"][0]["key"] == "stock:NVDA"
    assert r["settings"]["buyAt"] == 100 and r["settings"]["alertTf"] == "1h"
    service.update_state(lambda st: st["profile"]["holdings"][0].update(alerted={"stop": True}))
    again = client.put("/sync", json=PROFILE, headers=KEY).json()["profile"]
    assert again["holdings"][0]["alerted"] == {"stop": True}
    assert client.get("/sync", headers=KEY).json()["profile"]["updatedAt"] == 123


def test_push_subscribe_needs_keys(client, monkeypatch):
    sub = {"subscription": {"endpoint": "https://push.example/1", "keys": {"p256dh": "a", "auth": "b"}}}
    assert client.post("/push/subscribe", json=sub, headers=KEY).status_code == 503
    monkeypatch.setattr(service, "VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setattr(service, "VAPID_PRIVATE_KEY", "priv")
    assert client.post("/push/subscribe", json=sub, headers=KEY).json()["devices"] == 1
    assert client.post("/push/subscribe", json=sub, headers=KEY).json()["devices"] == 1
    assert client.post("/push/subscribe", json={"subscription": {}}, headers=KEY).status_code == 400
    sent = []
    monkeypatch.setattr(service, "_send", lambda s, p: sent.append(p) or True)
    assert client.post("/push/test", json={"endpoint": "https://push.example/1"}, headers=KEY).json()["sent"] == 1
    assert client.post("/push/test", json={"endpoint": "https://other"}, headers=KEY).status_code == 404
    assert client.get("/status", headers=KEY).json()["devices"] == 1
    assert client.post("/push/unsubscribe", json={"endpoint": "https://push.example/1"}, headers=KEY).json()["devices"] == 0


def test_quiet_hours_let_stop_losses_through(monkeypatch):
    monkeypatch.setattr(service, "VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setattr(service, "VAPID_PRIVATE_KEY", "priv")
    service.add_subscription({"endpoint": "e", "keys": {"p256dh": "a", "auth": "b"}})
    sent = []
    monkeypatch.setattr(service, "_send", lambda s, p: sent.append(p["title"]) or True)
    alerts = [{"kind": "signal", "title": "Buy", "body": ""}, {"kind": "stop", "title": "Stop", "body": "", "urgent": True}]
    night = datetime(2026, 1, 1, 23, 30)
    assert service.deliver(alerts, quiet=True, when=night) == 1
    assert sent == ["Stop"]
    assert service.deliver(alerts, quiet=False, when=night) == 2
    assert service.deliver(alerts, quiet=True, when=datetime(2026, 1, 1, 12, 0)) == 2


def test_gone_devices_are_removed(monkeypatch):
    monkeypatch.setattr(service, "VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setattr(service, "VAPID_PRIVATE_KEY", "priv")
    service.add_subscription({"endpoint": "e1", "keys": {}})
    service.add_subscription({"endpoint": "e2", "keys": {}})
    monkeypatch.setattr(service, "_send", lambda s, p: s["endpoint"] == "e1")
    assert service.send_to_all({"title": "x"}) == 1
    assert [s["endpoint"] for s in service.load_state()["subscriptions"]] == ["e1"]


def test_watch_run_saves_signals_alerts_and_holding_flags(monkeypatch):
    service.set_profile(PROFILE)
    monkeypatch.setattr(service, "VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setattr(service, "VAPID_PRIVATE_KEY", "priv")
    service.add_subscription({"endpoint": "e", "keys": {}})
    sent = []
    monkeypatch.setattr(service, "_send", lambda s, p: sent.append(p) or True)
    jobs = []

    def engine(job, timeout):
        jobs.append(job)
        return {
            "signals": {"stock:AAPL": {"action": "buy", "tf": "1h", "score": 50}},
            "alerts": [{"kind": "signal", "key": "stock:AAPL", "title": "Buy signal: AAPL", "body": "b", "hash": "chart/stock/AAPL"}],
            "holdingsAlerted": {"h1": {"stop": True}},
            "weights": {"stock:AAPL:1h": {"at": 1, "weights": {"rsi": 0.5}}},
            "errors": {"crypto:BTC": "down"},
        }

    service.run_watch(engine=engine)
    job = jobs[0]
    assert job["tf"] == "1h"
    assert [i["symbol"] for i in job["items"]] == ["AAPL", "BTC", "NVDA"]
    assert job["settings"]["buyAt"] == 100
    assert sent[0]["title"] == "Buy signal: AAPL" and sent[0]["hash"] == "chart/stock/AAPL"
    st = service.load_state()
    assert st["signals"]["stock:AAPL"]["action"] == "buy"
    assert st["profile"]["holdings"][0]["alerted"] == {"stop": True}
    assert st["watch"]["errors"] == {"crypto:BTC": "down"}
    assert st["weights"] == {"stock:AAPL:1h": {"at": 1, "weights": {"rsi": 0.5}}}
    assert service.watch_due(st, service.now_ms()) is False
    assert service.watch_due(st, service.now_ms() + 16 * 60_000) is True


def test_watch_runs_without_a_device_and_market_saves_results(client, monkeypatch):
    called = []
    service.set_profile(PROFILE)

    def watch(job, timeout):
        called.append(job)
        return {"signals": {}, "alerts": [{"kind": "signal", "key": "k", "title": "Buy signal: K", "body": ""}], "holdingsAlerted": {}, "weights": {}, "errors": {},
                "paper": {**job["paper"], "cash": 9000}, "paperEvents": [{"kind": "open", "text": "Bought K"}]}

    sent = []
    monkeypatch.setattr(service, "_send", lambda s, p: sent.append(p) or True)
    service.run_watch(engine=watch)
    # Signals and the paper account keep going with no phone signed up; nothing is pushed.
    assert called[0]["paper"]["start"] == 10000 and called[0]["riskPct"] == 1
    assert sent == []
    st = service.load_state()
    assert st["paper"]["cash"] == 9000 and st["paperEvents"][0]["text"] == "Bought K"
    body = client.get("/paper", headers=KEY).json()
    assert body["paper"]["cash"] == 9000 and body["events"][0]["text"] == "Bought K"

    def engine(job, timeout):
        assert job["mode"] == "market"
        return {"at": 5, "scanned": 3, "buys": [{"key": "stock:MMM"}], "sells": [], "actions": {"stock:MMM": "buy"}, "weights": {"w": 1}, "errors": {}, "alert": None}

    service.run_market(engine=engine)
    st = service.load_state()
    assert st["marketActions"] == {"stock:MMM": "buy"}
    assert "actions" not in st["market"] and st["market"]["scanned"] == 3
    body = client.get("/signals", headers=KEY).json()
    assert body["market"]["buys"][0]["key"] == "stock:MMM"


def test_market_slots():
    tz = service.tz()
    assert service.due_market_slot(datetime(2026, 1, 5, 9, 40, tzinfo=tz), None) is None
    slot = service.due_market_slot(datetime(2026, 1, 5, 9, 50, tzinfo=tz), None)
    assert slot.startswith("2026-01-05T09:45")
    assert service.due_market_slot(datetime(2026, 1, 5, 9, 55, tzinfo=tz), slot) is None
    assert service.next_market_at(datetime(2026, 1, 5, 21, 0, tzinfo=tz)).startswith("2026-01-06T09:45")


def test_engine_runs_with_node():
    """The real engine starts and answers an empty watch job."""
    out = service.run_engine({"mode": "watch", "tf": "1D", "settings": {"buyAt": 40, "sellAt": -40}, "items": [], "holdings": []}, 60)
    assert out["signals"] == {} and out["alerts"] == []
