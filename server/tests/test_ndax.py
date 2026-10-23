import os
import sys
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TRADE_API_KEY"] = "secret"
os.environ["TRADE_NO_SCHEDULER"] = "1"

import ndax  # noqa: E402
import service  # noqa: E402

TZ = ZoneInfo("America/Toronto")


class FakeNdax:
    """Just enough of ccxt's NDAX client: BTC and ETH for CAD, a $5 minimum."""

    def __init__(self, cad=1000.0):
        self.markets = {f"{c}/CAD": {"base": c, "quote": "CAD", "active": True, "limits": {"cost": {"min": 5}, "amount": {"min": 0.0001}}}
                        for c in ("BTC", "ETH")}
        self.cad = cad
        self.sent = []

    def load_markets(self):
        return self.markets

    def fetch_ticker(self, pair):
        return {"ask": 100.0, "bid": 110.0, "last": 105.0}

    def amount_to_precision(self, pair, qty):
        return f"{qty:.4f}"

    def create_order(self, pair, kind, side, qty):
        self.sent.append((pair, kind, side, qty))
        return {"id": str(len(self.sent)), "filled": qty, "average": 100.0 if side == "buy" else 110.0,
                "fee": {"cost": qty * 0.2, "currency": "CAD"}}

    def fetch_balance(self):
        return {"free": {"CAD": self.cad, "BTC": 1.0}}


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(service, "STATE_FILE", str(tmp_path / "trade.json"))
    monkeypatch.setattr(ndax, "API_KEY", "k")
    monkeypatch.setattr(ndax, "API_SECRET", "s")
    monkeypatch.setattr(ndax, "USER_ID", "1")
    yield


def setup_state(mode, budget=100, max_trade=25, loss=20):
    service.update_state(lambda st: st.update(
        profile={"watchlist": [], "holdings": [], "settings": {"ndaxMode": mode, "ndaxBudget": budget, "ndaxMaxTrade": max_trade, "ndaxDailyLoss": loss}},
        paper={"start": 1000, "history": [{"t": 0, "equity": 1000}]}))


BUY = {"kind": "open", "key": "crypto:BTC", "symbol": "BTC", "cost": 80, "qty": 0.8, "price": 100}
SELL = {"kind": "close", "key": "crypto:BTC", "symbol": "BTC", "price": 110, "pnl": 7.7, "reason": "target"}


def run(fake):
    return ndax.process(service.load_state, service.update_state, TZ, make=lambda private: fake)


def test_settings_are_kept_from_the_app():
    p = service.clean_profile({"settings": {"ndaxMode": "live", "ndaxBudget": 250, "ndaxMaxTrade": 40, "ndaxDailyLoss": 15}})["settings"]
    assert (p["ndaxMode"], p["ndaxBudget"], p["ndaxMaxTrade"], p["ndaxDailyLoss"]) == ("live", 250, 40, 15)
    assert service.clean_profile({"settings": {"ndaxMode": "yolo"}})["settings"]["ndaxMode"] == "off"


def test_nothing_is_queued_while_off():
    setup_state("off")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    assert not service.load_state().get("ndaxQueue")


def test_dry_run_records_without_sending_and_sizes_from_the_budget():
    setup_state("dry", budget=200)
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY, {**BUY, "key": "stock:AAPL", "symbol": "AAPL"}]}))
    assert [e["key"] for e in service.load_state()["ndaxQueue"]] == ["crypto:BTC"]  # crypto only
    fake = FakeNdax()
    [rec] = run(fake)
    assert fake.sent == []
    # 8% of the paper account, applied to a $200 budget: $16.
    assert rec["status"] == "dry" and rec["cad"] == 16.0 and rec["qty"] == 0.16
    box = service.load_state()["ndax"]
    assert box["positions"]["crypto:BTC"]["mode"] == "dry"
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [SELL]}))
    [sold] = run(fake)
    assert fake.sent == [] and sold["side"] == "sell" and sold["status"] == "dry" and sold["pnl"] > 0
    assert service.load_state()["ndax"]["positions"] == {}


def test_live_sends_market_orders_within_the_per_trade_limit():
    setup_state("live", budget=1000, max_trade=25)
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    fake = FakeNdax()
    [rec] = run(fake)
    assert fake.sent == [("BTC/CAD", "market", "buy", 0.25)]  # $80 of $1,000 budget, held to $25
    assert rec["status"] == "filled" and rec["fee"] == 0.05
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [SELL]}))
    [sold] = run(fake)
    assert fake.sent[-1] == ("BTC/CAD", "market", "sell", 0.25)
    assert sold["pnl"] == round(0.25 * 110 - 0.05 - (25 + 0.05), 2)


def test_switching_off_still_sells_what_was_really_bought():
    setup_state("live", budget=1000)
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    fake = FakeNdax()
    run(fake)
    setup_state("off")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [SELL, {**BUY, "key": "crypto:ETH", "symbol": "ETH"}]}))
    assert [e["kind"] for e in service.load_state()["ndaxQueue"]] == ["close"]
    run(fake)
    assert [s[2] for s in fake.sent] == ["buy", "sell"]


def test_small_orders_unknown_coins_and_the_daily_loss_limit_are_skipped():
    setup_state("live", budget=100, max_trade=25, loss=5)
    fake = FakeNdax()
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [
        {**BUY, "cost": 5},  # $0.50: under the $10 minimum
        {**BUY, "key": "crypto:DOGE", "symbol": "DOGE"},
    ]}))
    recs = run(fake)
    assert [r["status"] for r in recs] == ["skipped", "skipped"] and fake.sent == []
    now = ndax.now_ms()
    service.update_state(lambda st: ndax._box(st)["orders"].append({"at": now, "side": "sell", "mode": "live", "status": "filled", "pnl": -6}))
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    [rec] = run(fake)
    assert rec["status"] == "skipped" and "loss limit" in rec["error"] and fake.sent == []


def test_live_without_the_key_fails_without_sending(monkeypatch):
    monkeypatch.setattr(ndax, "API_KEY", "")
    setup_state("live")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    [rec] = run(FakeNdax())
    assert rec["status"] == "failed" and "key" in rec["error"]


def test_coin_list_limits_crypto_paper_buys():
    ndax.refresh_coins(service.update_state, make=lambda private: FakeNdax())
    state = service.load_state()
    assert ndax.tradable(state) == ["BTC", "ETH"]
    setup_state("off")
    assert service.paper_fields(service.load_state(), service.load_state()["profile"])["tradable"] == ["BTC", "ETH"]


def test_the_app_reads_the_ndax_summary(monkeypatch):
    import main
    from fastapi.testclient import TestClient
    monkeypatch.setattr(main, "API_KEY", "secret")
    monkeypatch.setattr(ndax, "API_KEY", "")
    setup_state("dry")
    r = TestClient(main.app).get("/ndax", headers={"X-API-Key": "secret"}).json()
    assert r["configured"] is False and r["mode"] == "dry" and r["orders"] == []


def test_the_trading_account_is_found_from_the_user_id_without_a_login(monkeypatch):
    import ccxt
    seen = []

    def fake_fetch(self, url, method="GET", headers=None, body=None):
        seen.append(url)
        return [449] if "GetUserAccounts" in url else []
    monkeypatch.setattr(ccxt.ndax, "fetch", fake_fetch)
    monkeypatch.setattr(ndax, "_account_id", "")
    ex = ndax.exchange(True)
    ex.fetch_balance()  # ccxt's own account lookup would ask for the login email
    assert ex.options["accountId"] == 449
    assert any("GetUserAccounts" in u and "UserId=1" in u for u in seen)
    assert any("GetAccountPositions" in u and "AccountId=449" in u for u in seen)


def test_the_profit_lock_setting_reaches_the_paper_account():
    p = service.clean_profile({"settings": {"paperExit": "lock"}})
    assert p["settings"]["paperExit"] == "lock"
    fields = service.paper_fields({}, p)
    assert fields["lock"] is True and fields["trail"] is False
