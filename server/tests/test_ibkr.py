import json
import os
import sys
import time
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

    def order(self, symbol, side, qty=None, usd=None):
        self.sent.append((symbol, side, qty if usd is None else f"${float(usd)}"))
        if usd is not None:
            qty = round(usd / 100.0, 4)
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
    monkeypatch.setattr(ibkr, "WEB_URL", "https://ibeam:5000")
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


def test_paper_buys_a_dollar_amount_from_the_budget_and_sells_it():
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    fake = FakeGateway()
    [rec] = run(fake)
    # 20% of the paper account on a $1,000 budget is $200: 2 shares at $100.
    assert fake.sent == [("MSFT", "buy", "$200.0")]
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
    assert fake.sent == [("MSFT", "buy", "$50.0")] and rec["status"] == "filled" and rec["qty"] == 0.5
    # The paper sale sells the same fraction.
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [SELL]}))
    run(fake)
    assert fake.sent[-1] == ("MSFT", "sell", 0.5)


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
    fake.held["MSFT"] = 1.9512   # the price moved overnight: $200 bought a little less
    service.update_state(lambda st: ibkr._box(st).update(accountAt=0))  # IBKR is asked again after a minute
    out = ibkr.summary(service.load_state(), service.update_state, make=lambda: fake)
    assert out["orders"][0]["status"] == "filled" and out["account"]["paper"] is True
    assert out["orders"][0]["qty"] == 1.9512 and out["positions"]["stock:MSFT"]["qty"] == 1.9512
    assert service.load_state()["ibkr"]["orders"][0]["status"] == "filled"


def test_without_the_gateway_orders_fail_without_sending(monkeypatch):
    monkeypatch.setattr(ibkr, "WEB_URL", "")
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    [rec] = run(FakeGateway())
    assert rec["status"] == "failed" and "IBKR_WEB_URL" in rec["error"]


def test_the_app_reads_the_ibkr_summary(monkeypatch):
    import main
    from fastapi.testclient import TestClient
    monkeypatch.setattr(main, "API_KEY", "secret")
    monkeypatch.setattr(ibkr, "WEB_URL", "")
    setup_state("paper")
    r = TestClient(main.app).get("/ibkr", headers={"X-API-Key": "secret"}).json()
    assert r["configured"] is False and r["mode"] == "paper" and r["orders"] == []


def test_class_shares_use_ibkrs_spelling():
    assert ibkr.ib_symbol("BRK.B") == "BRK B"
    assert ibkr.fee_estimate(10, 100) == 1.0 and ibkr.fee_estimate(1000, 10) == 5.0 and ibkr.fee_estimate(1, 50) == 0.5


def test_a_job_stuck_on_the_gateway_is_reported():
    setup_state("paper")
    assert ibkr._take("placing orders")
    try:
        ibkr._busy["since"] = ibkr.now_ms() - 6 * 60_000
        r = ibkr.summary(service.load_state(), service.update_state, make=lambda: FakeGateway())
        assert "placing orders" in r["error"] and "6 min without an answer" in r["error"]
    finally:
        ibkr._give()
    r = ibkr.summary(service.load_state(), service.update_state, make=lambda: FakeGateway())
    assert not r.get("error")


def test_a_logged_out_ibkr_fails_orders_without_retrying_and_shows_in_settings():
    setup_state("paper")
    service.update_state(lambda st: service.save_paper(st, {"paperEvents": [BUY]}))
    tries = []

    def out():
        tries.append(1)
        raise ibkr.LoggedOut()
    [rec] = run_with(out)
    assert len(tries) == 1 and rec["status"] == "failed" and "log in from Settings" in rec["error"]
    r = ibkr.summary(service.load_state(), service.update_state, make=out)
    assert r["loggedOut"] is True and not r["error"]
    r = ibkr.summary(service.load_state(), service.update_state, make=lambda: FakeGateway())
    assert r["loggedOut"] is False and r["account"]["id"] == "DU123"


@pytest.fixture
def ibeam(monkeypatch):
    calls, alerts = [], []
    monkeypatch.setattr(ibkr, "IBEAM_URL", "http://ibeam:5001")
    monkeypatch.setattr(ibkr, "_ibeam", lambda path: calls.append(path) or True)
    monkeypatch.setattr(ibkr, "CODE_WAIT_S", 2)
    ibkr._login.update(asked=None, waiting=None, code=None, outAt=None, alerted=False)
    yield calls, lambda title, body: alerts.append(title), alerts


def test_a_login_nobody_asked_for_puts_ibeam_back_to_sleep(ibeam):
    calls, alert, alerts = ibeam
    assert ibkr.wait_code(alert) is None
    assert ibkr.wait_code(alert) is None
    assert calls == ["/deactivate", "/deactivate"] and alerts == ["IBKR logged out"]  # one alert, not one a minute


def test_the_typed_code_goes_to_ibeam(ibeam):
    import threading
    calls, alert, alerts = ibeam
    assert ibkr.ask_login()["ok"] and calls == ["/activate"]
    assert ibkr.give_code("123456")["ok"] is False   # IBKR hasn't asked yet
    got = []
    t = threading.Thread(target=lambda: got.append(ibkr.wait_code(alert)))
    t.start()
    for _ in range(100):
        if ibkr.login_info()["waitingCode"]:
            break
        time.sleep(0.01)
    assert ibkr.give_code("12ab56")["ok"] is False
    assert ibkr.give_code(" 123456 ")["ok"] is True
    t.join(3)
    assert got == ["123456"] and alerts == ["IBKR login code"] and not ibkr.login_info()["waitingCode"]


def test_no_code_in_time_goes_back_to_sleep(ibeam):
    calls, alert, alerts = ibeam
    ibkr.ask_login()
    assert ibkr.wait_code(alert) is None
    assert calls == ["/activate", "/deactivate"] and alerts == ["IBKR login code", "IBKR logged out"]


def test_ibeam_gets_the_code_as_plain_text(ibeam, monkeypatch):
    import main
    from fastapi.testclient import TestClient
    monkeypatch.setattr(main, "API_KEY", "secret")
    monkeypatch.setattr(service.ibkr, "wait_code", lambda alert: "654321")
    r = TestClient(main.app).post("/ibkr/2fa", headers={"X-API-Key": "secret"})
    assert r.status_code == 200 and r.text == "654321"
    monkeypatch.setattr(service.ibkr, "wait_code", lambda alert: None)
    assert TestClient(main.app).post("/ibkr/2fa", headers={"X-API-Key": "secret"}).status_code == 503
    assert TestClient(main.app).post("/ibkr/2fa").status_code == 401


class FakeWebApi:
    """IBKR's Web API answers, served on localhost, for the real Gateway class."""

    def __init__(self, logged_in=True):
        import http.server
        import threading
        api = self
        self.logged_in, self.orders, self.status = logged_in, [], "Filled"

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                p = self.path.replace("/v1/api", "")
                if p == "/iserver/auth/status":
                    return self.reply(200, {"authenticated": api.logged_in, "connected": True})
                if not api.logged_in:
                    return self.reply(401, {"error": "not authenticated"})
                routes = {
                    "/iserver/accounts": {"accounts": ["DU77"], "selectedAccount": "DU77"},
                    "/portfolio/accounts": [{"id": "DU77"}],
                    "/portfolio/DU77/summary": {"availablefunds": {"amount": 950.5, "currency": "USD"}, "netliquidation": {"amount": 1000.0, "currency": "USD"}},
                    "/portfolio/DU77/positions/0": [{"conid": 1, "contractDesc": "BRK B", "position": 0.0354, "assetClass": "STK"}],
                    "/trsrv/stocks?symbols=BRK%20B": {"BRK B": [{"contracts": [{"conid": 72063691, "isUS": True}]}]},
                    "/iserver/account/order/status/9": {"order_status": api.status, "cum_fill": "0.0354", "average_price": "339.10"},
                    "/iserver/account/trades": [{"order_id": 9, "commission": "1.00"}],
                    "/iserver/account/orders": {"orders": [{"orderId": 9, "status": "Submitted"}]},
                }
                return self.reply(200, routes[p]) if p in routes else self.reply(404, {"error": f"no route {p}"})

            def do_POST(self):
                p = self.path.replace("/v1/api", "")
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if p == "/iserver/account/DU77/orders":
                    api.orders.append(body["orders"][0])
                    return self.reply(200, [{"id": "r1", "message": ["This is a fractional order. Continue?"]}])
                if p == "/iserver/reply/r1":
                    return self.reply(200, [{"order_id": "9", "order_status": "Submitted"}])
                return self.reply(200, {})

        self.server = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def stop(self):
        self.server.shutdown()


def test_the_web_api_client_buys_by_dollar_amount_and_reads_the_account(monkeypatch):
    api = FakeWebApi()
    monkeypatch.setattr(ibkr, "WEB_URL", api.url)
    try:
        gw = ibkr.Gateway()
        assert gw.account == "DU77"
        assert gw.funds() == {"currency": "USD", "available": 950.5, "net": 1000.0}
        assert gw.positions() == {"BRK.B": 0.0354}
        r = gw.order("BRK.B", "buy", usd=12.0)
        assert api.orders == [{"conid": 72063691, "orderType": "MKT", "side": "BUY", "tif": "DAY", "cashQty": 12.0}]
        assert r == {"status": "filled", "filled": 0.0354, "price": 339.10, "fee": 1.0, "id": "9"}
        assert gw.working() == {"9"}
    finally:
        api.stop()


def test_the_web_api_client_knows_a_logged_out_session(monkeypatch):
    api = FakeWebApi(logged_in=False)
    monkeypatch.setattr(ibkr, "WEB_URL", api.url)
    try:
        with pytest.raises(ibkr.LoggedOut):
            ibkr.Gateway()
    finally:
        api.stop()
