import os
import sys
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TRADE_API_KEY"] = "secret"
os.environ["TRADE_NO_SCHEDULER"] = "1"

import ibkr  # noqa: E402
import service  # noqa: E402

TZ = ZoneInfo("America/Toronto")


class FakeGateway:
    """Just enough of IB Gateway: a paper account with $100,000 and fills at the asked price."""

    def __init__(self, account="DU123", market_open=True):
        self.account = account
        self.market_open = market_open
        self.held = {}
        self.sent = []
        self.open_ids = set()

    def close(self):
        pass

    def funds(self):
        return {"currency": "USD", "available": 100_000.0, "net": 100_000.0}

    def positions(self):
        return dict(self.held)

    def order(self, symbol, side, qty):
        self.sent.append((symbol, side, qty))
        oid = len(self.sent)
        if not self.market_open:
            self.open_ids.add(oid)
            return {"status": "working", "filled": 0, "price": 0, "id": oid}
        self.held[symbol] = self.held.get(symbol, 0) + (qty if side == "buy" else -qty)
        return {"status": "filled", "filled": qty, "price": 100.0 if side == "buy" else 110.0, "fee": 1.0, "id": oid}

    def working(self):
        return set(self.open_ids)


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(service, "STATE_FILE", str(tmp_path / "trade.json"))
    monkeypatch.setattr(ibkr, "HOST", "ib-gateway")
    monkeypatch.setattr(ibkr, "CONNECT_RETRY_S", 0)
    yield


def setup_state(mode, budget=1000, max_trade=250, loss=50):
    service.update_state(lambda st: st.update(
        profile={"watchlist": [], "holdings": [], "settings": {"ibkrMode": mode, "ibkrBudget": budget, "ibkrMaxTrade": max_trade, "ibkrDailyLoss": loss}},
        paper={"start": 1000, "history": [{"t": 0, "equity": 1000}]}))


BUY = {"kind": "open", "key": "stock:MSFT", "symbol": "MSFT", "cost": 200, "qty": 2, "price": 100}
SELL = {"kind": "close", "key": "stock:MSFT", "symbol": "MSFT", "price": 110, "pnl": 18, "reason": "target"}


def run(fake):
    return ibkr.process(service.load_state, service.update_state, TZ, make=lambda: fake)


def run_with(make):
    return ibkr.process(service.load_state, service.update_state, TZ, make=make)


def test_settings_are_kept_from_the_app():
    p = service.clean_profile({"settings": {"ibkrMode": "paper", "ibkrBudget": 5000, "ibkrMaxTrade": 500, "ibkrDailyLoss": 80}})["settings"]
    assert (p["ibkrMode"], p["ibkrBudget"], p["ibkrMaxTrade"], p["ibkrDailyLoss"]) == ("paper", 5000, 500, 80)
    assert service.clean_profile({"settings": {"ibkrMode": "live"}})["settings"]["ibkrMode"] == "off"  # paper only for now


def test_only_stocks_are_queued_and_nothing_while_off():
    setup_state("off")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    assert not service.load_state().get("ibkrQueue")
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY, {**BUY, "key": "crypto:BTC", "symbol": "BTC"}]}))
    assert [e["key"] for e in service.load_state()["ibkrQueue"]] == ["stock:MSFT"]


def test_paper_buys_whole_shares_from_the_budget_and_sells_them():
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    fake = FakeGateway()
    [rec] = run(fake)
    # 20% of the paper account on a $1,000 budget is $200: 2 shares at $100.
    assert fake.sent == [("MSFT", "buy", 2)]
    assert rec["status"] == "filled" and rec["qty"] == 2 and rec["fee"] == 1.0
    assert service.load_state()["ibkr"]["positions"]["stock:MSFT"]["usd"] == 201.0
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [SELL]}))
    [sold] = run(fake)
    assert fake.sent[-1] == ("MSFT", "sell", 2)
    assert sold["pnl"] == round(2 * 110 - 1 - 201, 2)
    assert service.load_state()["ibkr"]["positions"] == {}


def test_a_share_dearer_than_the_trade_buys_a_fraction():
    setup_state("paper", max_trade=50)
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    fake = FakeGateway()
    [rec] = run(fake)
    # $50 at most per trade, $100 a share: half a share.
    assert fake.sent == [("MSFT", "buy", 0.5)] and rec["status"] == "filled"


def test_fractions_round_down_to_four_decimals():
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [{**BUY, "cost": 12.13, "price": 342.33}]}))
    fake = FakeGateway()
    run(fake)
    assert fake.sent == [("MSFT", "buy", 0.0354)]  # $12.13 ÷ $342.33 = 0.03543…


def test_under_ten_dollars_is_skipped():
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [{**BUY, "cost": 5}]}))
    fake = FakeGateway()
    [rec] = run(fake)
    assert rec["status"] == "skipped" and fake.sent == []


def test_a_dropped_connection_is_tried_again():
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    fake, tries = FakeGateway(), []

    def flaky():
        tries.append(1)
        if len(tries) < 2:
            raise TimeoutError()
        return fake
    [rec] = run_with(flaky)
    assert len(tries) == 2 and rec["status"] == "filled"


def test_an_unanswering_gateway_names_the_error():
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))

    def down():
        raise TimeoutError()
    [rec] = run_with(down)
    assert rec["status"] == "failed" and rec["error"].endswith("TimeoutError") and "3 tries" in rec["error"]


def test_a_live_account_is_never_traded_in_paper_mode():
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    fake = FakeGateway(account="U999")
    [rec] = run(fake)
    assert rec["status"] == "failed" and "live account" in rec["error"] and fake.sent == []


def test_a_sale_never_sells_more_than_ibkr_holds():
    setup_state("paper")
    service.update_state(lambda st: ibkr._box(st)["positions"].update({"stock:MSFT": {"symbol": "MSFT", "qty": 2, "usd": 201, "mode": "paper"}}))
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [SELL]}))
    fake = FakeGateway()  # holds nothing
    [rec] = run(fake)
    assert rec["status"] == "skipped" and fake.sent == []


def test_orders_placed_while_the_market_is_closed_wait_then_settle():
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    fake = FakeGateway(market_open=False)
    [rec] = run(fake)
    assert rec["status"] == "working"
    # At the open IBKR fills it.
    fake.open_ids.clear()
    fake.held["MSFT"] = 2
    service.update_state(lambda st: ibkr._box(st).update(accountAt=0))  # IBKR is asked again after a minute
    out = ibkr.summary(service.load_state(), service.update_state, make=lambda: fake)
    assert out["orders"][0]["status"] == "filled" and out["account"]["paper"] is True
    assert service.load_state()["ibkr"]["orders"][0]["status"] == "filled"


def test_without_the_gateway_orders_fail_without_sending(monkeypatch):
    monkeypatch.setattr(ibkr, "HOST", "")
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    [rec] = run(FakeGateway())
    assert rec["status"] == "failed" and "IBKR_HOST" in rec["error"]


def test_the_app_reads_the_ibkr_summary(monkeypatch):
    import main
    from fastapi.testclient import TestClient
    monkeypatch.setattr(main, "API_KEY", "secret")
    monkeypatch.setattr(ibkr, "HOST", "")
    setup_state("paper")
    r = TestClient(main.app).get("/ibkr", headers={"X-API-Key": "secret"}).json()
    assert r["configured"] is False and r["mode"] == "paper" and r["orders"] == []


def test_class_shares_use_ibkrs_spelling():
    assert ibkr.ib_symbol("BRK.B") == "BRK B"
    assert ibkr.fee_estimate(10, 100) == 1.0 and ibkr.fee_estimate(1000, 10) == 5.0 and ibkr.fee_estimate(1, 50) == 0.5
