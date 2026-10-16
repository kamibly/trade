import json
import os
import sys
import zipfile
from datetime import date, datetime, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TRADE_API_KEY"] = "secret"
os.environ["TRADE_NO_SCHEDULER"] = "1"

import events  # noqa: E402
import service  # noqa: E402
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

KEY = {"X-API-Key": "secret"}
DAY = 86400


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(service, "STATE_FILE", str(tmp_path / "trade.json"))
    monkeypatch.setattr(main, "API_KEY", "secret")
    yield


def tsv(rows):
    head = list(rows[0])
    return "\n".join(["\t".join(head)] + ["\t".join(str(r[h]) for h in head) for r in rows]) + "\n"


def make_form345(path):
    """A tiny quarterly insider data set: a director's purchase counts; a sale,
    a 10% owner's purchase and a company outside the S&P 500 don't."""
    sub = [
        {"ACCESSION_NUMBER": "A1", "FILING_DATE": "05-FEB-2024", "DOCUMENT_TYPE": "4", "ISSUERCIK": "0000320193", "ISSUERTRADINGSYMBOL": "AAPL"},
        {"ACCESSION_NUMBER": "A2", "FILING_DATE": "06-FEB-2024", "DOCUMENT_TYPE": "4", "ISSUERCIK": "320193", "ISSUERTRADINGSYMBOL": "AAPL"},
        {"ACCESSION_NUMBER": "A3", "FILING_DATE": "07-FEB-2024", "DOCUMENT_TYPE": "4", "ISSUERCIK": "320193", "ISSUERTRADINGSYMBOL": "AAPL"},
        {"ACCESSION_NUMBER": "A4", "FILING_DATE": "07-FEB-2024", "DOCUMENT_TYPE": "4", "ISSUERCIK": "999", "ISSUERTRADINGSYMBOL": "TINY"},
    ]
    owners = [
        {"ACCESSION_NUMBER": "A1", "RPTOWNERCIK": "0000001", "RPTOWNERNAME": "Doe Jane", "RPTOWNER_RELATIONSHIP": "Director", "RPTOWNER_TITLE": ""},
        {"ACCESSION_NUMBER": "A2", "RPTOWNERCIK": "0000002", "RPTOWNERNAME": "Roe Rich", "RPTOWNER_RELATIONSHIP": "Officer", "RPTOWNER_TITLE": "CFO"},
        {"ACCESSION_NUMBER": "A3", "RPTOWNERCIK": "0000003", "RPTOWNERNAME": "Big Fund", "RPTOWNER_RELATIONSHIP": "TenPercentOwner", "RPTOWNER_TITLE": ""},
        {"ACCESSION_NUMBER": "A4", "RPTOWNERCIK": "0000004", "RPTOWNERNAME": "Small Co", "RPTOWNER_RELATIONSHIP": "Director", "RPTOWNER_TITLE": ""},
    ]
    trans = [
        {"ACCESSION_NUMBER": "A1", "TRANS_CODE": "P", "TRANS_SHARES": "1000", "TRANS_PRICEPERSHARE": "180", "TRANS_ACQUIRED_DISP_CD": "A"},
        {"ACCESSION_NUMBER": "A1", "TRANS_CODE": "P", "TRANS_SHARES": "100", "TRANS_PRICEPERSHARE": "181", "TRANS_ACQUIRED_DISP_CD": "A"},
        {"ACCESSION_NUMBER": "A2", "TRANS_CODE": "S", "TRANS_SHARES": "5000", "TRANS_PRICEPERSHARE": "180", "TRANS_ACQUIRED_DISP_CD": "D"},
        {"ACCESSION_NUMBER": "A3", "TRANS_CODE": "P", "TRANS_SHARES": "9000", "TRANS_PRICEPERSHARE": "180", "TRANS_ACQUIRED_DISP_CD": "A"},
        {"ACCESSION_NUMBER": "A4", "TRANS_CODE": "P", "TRANS_SHARES": "9000", "TRANS_PRICEPERSHARE": "10", "TRANS_ACQUIRED_DISP_CD": "A"},
    ]
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("SUBMISSION.tsv", tsv(sub))
        zf.writestr("REPORTINGOWNER.tsv", tsv(owners))
        zf.writestr("NONDERIV_TRANS.tsv", tsv(trans))


def test_quarterly_insider_data_keeps_only_open_market_buys_by_officers_and_directors(tmp_path):
    path = tmp_path / "q.zip"
    make_form345(path)
    rows = events.parse_form345(str(path), {320193: "AAPL"})
    assert len(rows) == 1
    r = rows[0]
    assert r["symbol"] == "AAPL" and r["acc"] == "A1" and r["role"] == "Director" and r["owner"] == "1"
    assert r["value"] == 1000 * 180 + 100 * 181
    assert r["filed"] == int(datetime(2024, 2, 5, tzinfo=timezone.utc).timestamp())


FORM4 = """<SEC-DOCUMENT>
<XML>
<ownershipDocument>
  <issuer><issuerCik>0000320193</issuerCik><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001214156</rptOwnerCik><rptOwnerName>Cook Timothy</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>2000</value></transactionShares><transactionPricePerShare><value>150.5</value></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>9999</value></transactionShares><transactionPricePerShare><value>1</value></transactionPricePerShare>
      <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
</XML>
</SEC-DOCUMENT>"""


def test_form4_filing_and_daily_index():
    f = events.parse_form4(FORM4)
    assert f == {"issuer": 320193, "owner": "1214156", "name": "Cook Timothy", "role": "CEO", "value": 301000}
    # A sale only, or an outside holder: nothing.
    assert events.parse_form4(FORM4.replace("<transactionCode>P<", "<transactionCode>S<")) is None
    assert events.parse_form4(FORM4.replace("<isDirector>1<", "<isDirector>0<").replace("<isOfficer>1<", "<isOfficer>0<")) is None
    index = (
        "Form Type   Company Name   CIK   Date Filed  File Name\n"
        "-----------------------------------------------------------\n"
        "10-K        APPLE INC      320193   20240205    edgar/data/320193/0000320193-24-000010.txt\n"
        "4           APPLE INC      320193   20240205    edgar/data/320193/0001214156-24-000002.txt\n"
        "4/A         APPLE INC      320193   20240205    edgar/data/320193/0001214156-24-000003.txt\n"
    )
    rows = events.parse_daily_index(index)
    assert rows == [{"cik": 320193, "date": events.parse_sec_date("20240205"), "path": "edgar/data/320193/0001214156-24-000002.txt"}]


def test_earnings_dates_from_sec_filings_and_nasdaq():
    subs = {"filings": {"recent": {
        "form": ["8-K", "8-K", "4", "8-K/A", "10-Q"],
        "items": ["2.02,9.01", "5.02", "", "2.02", ""],
        "acceptanceDateTime": ["2024-02-01T16:30:42.000Z", "2024-03-01T08:00:00.000Z", "2024-02-02T18:00:00.000Z", "2024-02-01T17:05:00.000Z", "2024-02-02T16:00:00.000Z"],
    }}}
    rel = events.parse_submissions(subs)
    # One release (the amendment the same day is the same one), at 16:30 New York time.
    assert len(rel) == 1
    assert datetime.fromtimestamp(rel[0], events.NEW_YORK).strftime("%Y-%m-%d %H:%M") == "2024-02-01 16:30"
    cal = events.parse_nasdaq({"data": {"rows": [{"symbol": "AAPL", "time": "time-after-hours"}, {"symbol": "BRK/B", "time": "time-not-supplied"}]}}, date(2024, 5, 2))
    assert cal["AAPL"]["when"] == "after the close" and "BRK.B" in cal
    assert events.parse_nasdaq({"data": None}, date(2024, 5, 2)) == {}


def test_fear_greed_and_funding():
    fng = events.parse_fng({"data": [{"value": "20", "timestamp": "1700006400"}, {"value": "80", "timestamp": "1699920000"}, {"value": "x"}]})
    assert fng == [[1699920000, 80], [1700006400, 20]]
    now = 1700000000 + 2 * DAY
    data = {"rates": [
        {"timestamp": "2023-11-14T00:00:00.000Z", "relativeFundingRate": 0.0001},
        {"timestamp": "2023-11-14T01:00:00.000Z", "relativeFundingRate": 0.0002},
        {"timestamp": "2023-11-15T00:00:00.000Z", "relativeFundingRate": -0.0001},
        {"timestamp": datetime.fromtimestamp(now, timezone.utc).isoformat(), "relativeFundingRate": 0.01},  # today: left out
    ]}
    assert events.parse_kraken_funding(data, now) == [[1699920000, 0.0003], [1700006400, -0.0001]]


def test_refresh_saves_every_source_and_the_engine_input(tmp_path):
    folder = str(tmp_path / "events")
    zpath = tmp_path / "q.zip"
    make_form345(zpath)
    now = datetime(2024, 4, 10, 15, tzinfo=timezone.utc).timestamp()
    asked = []

    def get(url, headers=None):
        asked.append(url)
        if "alternative.me" in url:
            return json.dumps({"data": [{"value": "12", "timestamp": "1712620800"}]}).encode()
        if "kraken" in url:
            return json.dumps({"rates": [{"timestamp": "2024-04-08T00:00:00Z", "relativeFundingRate": 0.0001}]}).encode()
        if "nasdaq" in url:
            return json.dumps({"data": {"rows": [{"symbol": "AAPL", "time": "time-after-hours"}] if "2024-04-11" in url else []}}).encode()
        if "submissions" in url:
            return json.dumps({"filings": {"recent": {"form": ["8-K"], "items": ["2.02"], "acceptanceDateTime": ["2024-02-01T16:30:42.000Z"]}}}).encode()
        if "daily-index" in url:
            raise events.NotFound(url)
        raise AssertionError(url)

    def download(url, path, headers):
        assert "Trade app me@example.com" in headers["User-Agent"]
        if "2024q1" not in url:
            raise events.NotFound(url)
        with open(zpath, "rb") as src, open(path, "wb") as dst:
            dst.write(src.read())

    sec = events.Sec("me@example.com", get=get, download=download)
    sec_wait = events.SEC_GAP_S
    events.SEC_GAP_S = 0
    try:
        status = events.refresh(folder, {320193: "AAPL"}, now=now, get=get, sec=sec, contact="me@example.com")
    finally:
        events.SEC_GAP_S = sec_wait
    assert status["fng"]["ok"] and status["funding"]["ok"] and status["insiders"]["ok"] and status["earnings"]["ok"]
    assert status["insiders"]["count"] == 1 and status["calendar"]["count"] == 1
    ev = events.load_events(folder)
    assert ev["insiders"]["AAPL"][0]["value"] == 180_000 + 18_100
    assert set(ev["insiders"]["AAPL"][0]) == {"filed", "owner", "name", "role", "value"}
    assert len(ev["earnings"]["AAPL"]) == 1 and ev["fng"] == [[1712620800, 12]] and ev["funding"]["BTC"][0][1] == 0.0001
    assert events.next_earnings(folder)["AAPL"]["estimated"] is False
    # The daily data isn't fetched again within the day.
    asked.clear()
    events.refresh(folder, {320193: "AAPL"}, now=now + 3600, get=get, sec=sec, contact="me@example.com")
    assert not any("submissions" in u or "nasdaq" in u for u in asked)


def test_without_sec_contact_the_sec_sources_wait(tmp_path):
    def get(url, headers=None):
        assert "sec.gov" not in url
        return b"{}"

    status = events.refresh(str(tmp_path), {320193: "AAPL"}, now=1712761200, get=get, contact="")
    assert not status["insiders"]["ok"] and "SEC_CONTACT" in status["insiders"]["error"]
    assert "SEC_CONTACT" in status["earnings"]["error"]


def test_earnings_warning_two_trading_days_ahead_for_held_stocks():
    thu = int(datetime(2024, 5, 2, tzinfo=timezone.utc).timestamp())
    nxt = {"AAPL": {"at": thu, "when": "after the close", "estimated": False}, "MSFT": {"at": thu + 7 * DAY, "when": "", "estimated": True}}
    held = ["stock:AAPL", "stock:MSFT", "crypto:BTC"]
    assert events.earnings_warnings(nxt, held, date(2024, 4, 29)) == []  # Monday: 3 trading days ahead
    w = events.earnings_warnings(nxt, held, date(2024, 4, 30))  # Tuesday
    assert [x["key"] for x in w] == ["stock:AAPL"]
    assert w[0]["title"] == "AAPL reports earnings Thursday"
    assert "after the close" in w[0]["body"] and w[0]["id"] == "pre-earnings:stock:AAPL:2024-05-02"
    assert events.earnings_warnings(nxt, ["stock:AAPL"], date(2024, 5, 3)) == []  # already reported


PROFILE = {"watchlist": [{"type": "crypto", "symbol": "BTC"}], "holdings": [{"id": "h1", "type": "stock", "symbol": "AAPL", "qty": 1, "buyPrice": 100}], "settings": {"quietHours": False}}


def push_on(monkeypatch):
    monkeypatch.setattr(service, "VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setattr(service, "VAPID_PRIVATE_KEY", "priv")
    service.add_subscription({"endpoint": "e1", "keys": {"p256dh": "a", "auth": "b"}})
    sent = []
    monkeypatch.setattr(service, "_send", lambda s, p: sent.append(p) or True)
    return sent


def test_ratings_mute_a_setup_and_it_can_be_turned_back_on(monkeypatch):
    client = TestClient(main.app)
    sent = push_on(monkeypatch)
    service.set_profile(PROFILE)
    for useful in [True, False, False, False, False, False, False]:
        r = client.post("/feedback", headers=KEY, json={"setups": ["insider"], "useful": useful})
        assert r.status_code == 200
    assert r.json()["setups"]["muted"] == []  # 6 of 7
    r = client.post("/feedback", headers=KEY, json={"setups": ["insider"], "useful": False})
    assert r.json()["setups"]["muted"] == ["insider"]
    assert client.post("/feedback", headers=KEY, json={"setups": ["nope"], "useful": False}).status_code == 400

    alerts = [
        {"kind": "opportunities", "setups": ["insider"], "ids": ["insider:stock:AAPL:1"], "title": "Opportunity: AAPL", "body": "x"},
        {"kind": "signal", "key": "crypto:BTC", "setups": ["signal"], "title": "Buy signal: BTC", "body": "y"},
        {"kind": "stop", "key": "stock:AAPL", "title": "Stop-loss hit: AAPL", "body": "z"},
    ]
    service.deliver(alerts, quiet=False, muted=service.muted_setups(service.load_state()))
    assert [p["title"] for p in sent] == ["Buy signal: BTC", "Stop-loss hit: AAPL"]
    assert sent[0]["feedback"] == {"setups": ["signal"], "id": "signal:crypto:BTC"}
    assert "feedback" not in sent[1]

    r = client.post("/setups/unmute", headers=KEY, json={"setup": "insider"})
    assert r.json()["setups"]["muted"] == []
    sent.clear()
    service.deliver(alerts[:1], quiet=False, muted=service.muted_setups(service.load_state()))
    assert sent[0]["feedback"] == {"setups": ["insider"], "id": "insider:stock:AAPL:1"}


def test_market_scan_sends_each_opportunity_once_and_paper_trades_them(monkeypatch):
    sent = push_on(monkeypatch)
    service.set_profile({**PROFILE, "settings": {"quietHours": False, "setups": {"crowd": False}}})
    opp = {"id": "insider:stock:AAPL:9", "setup": "insider", "key": "stock:AAPL", "symbol": "AAPL", "type": "stock", "entry": 100, "stop": 90, "take": 130, "hold": 20, "ev": 0.03}
    jobs = []

    def engine(job, timeout):
        jobs.append(job)
        if job["mode"] == "paper":
            return {"paper": {**job["paper"], "positions": [{"key": "stock:AAPL", "setup": "insider"}]}, "paperEvents": [{"kind": "open", "text": "Bought AAPL"}]}
        dig = None if opp["id"] in job["announced"] else {"kind": "opportunities", "setups": ["insider"], "ids": [opp["id"]], "title": "Opportunity: AAPL", "body": "b", "hash": "signals"}
        return {"at": 5, "scanned": 1, "buys": [], "sells": [], "actions": {}, "weights": {}, "errors": {}, "alert": None,
                "opportunities": [opp], "records": {"insider": {"n": 40, "wins": 25, "avg": 0.02}}, "counts": {}, "warnings": [], "digest": dig}

    service.run_market(engine=engine)
    market = jobs[0]
    assert market["enabled"] == {"insider": True, "earnings": True, "ranking": True, "crowd": False}
    assert market["held"] == ["stock:AAPL"] and "insiders" in market["events"]
    assert [p["title"] for p in sent] == ["Opportunity: AAPL"]
    assert jobs[1]["mode"] == "paper" and jobs[1]["opportunities"] == [opp]
    st = service.load_state()
    assert st["announced"] == [opp["id"]] and st["paper"]["positions"][0]["setup"] == "insider"
    assert st["market"]["records"]["insider"]["n"] == 40
    sent.clear()
    service.run_market(engine=engine)
    assert sent == []  # already announced


def test_events_run_warns_once_before_earnings(monkeypatch):
    sent = push_on(monkeypatch)
    service.set_profile(PROFILE)
    today = datetime.now(service.NEW_YORK).date()
    monkeypatch.setattr(events, "next_earnings", lambda folder: {"AAPL": {"at": int(datetime(today.year, today.month, today.day, tzinfo=timezone.utc).timestamp()), "when": "", "estimated": True}})
    out = service.run_events(refresher=lambda folder, ciks: {"fng": {"ok": True}})
    assert out["fng"]["ok"] and [w["key"] for w in out["warnings"]] == ["stock:AAPL"]
    assert sent[0]["title"] == "AAPL reports earnings today"
    sent.clear()
    service.run_events(refresher=lambda folder, ciks: {})
    assert sent == []
    st = service.load_state()
    assert st["events"]["lastRunAt"] and not service.events_due(st, service.now_ms())


def test_sec_answers_403_for_missing_files_and_for_its_rate_limit():
    import io
    import urllib.error

    def err(code, body, url="https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/form.20260907.idx"):
        return events._http_error(url, urllib.error.HTTPError(url, code, "x", {}, io.BytesIO(body)))

    assert isinstance(err(403, b"<Error><Code>AccessDenied</Code></Error>"), events.NotFound)  # Labor Day: no index
    assert isinstance(err(403, b"Your Request Originated from an Undeclared Automated Tool"), events.Blocked)
    assert isinstance(err(403, b"Request Rate Threshold Exceeded"), events.Blocked)
    assert isinstance(err(404, b""), events.NotFound)
    assert not isinstance(err(403, b"", url="https://api.nasdaq.com/x"), events.NotFound)


def test_insider_data_sets_try_the_new_sec_address_first(tmp_path):
    asked = []

    def download(url, path, headers):
        asked.append(url)
        if "datastandardsinnovation" in url and "2026q2" not in url:
            raise events.NotFound(url)
        if "structureddata" in url and "2026q2" in url:
            raise AssertionError("2026q2 is only at the new address")
        make_form345(path)

    def get(url, headers=None):
        raise events.NotFound(url)

    sec = events.Sec("me@example.com", get=get, download=download)
    sec_wait = events.SEC_GAP_S
    events.SEC_GAP_S = 0
    try:
        out = events.refresh_insiders(str(tmp_path), sec, {320193: "AAPL"}, date(2026, 10, 16), 1_771_000_000, max_days=0)
    finally:
        events.SEC_GAP_S = sec_wait
    assert out["quarters"] == 8 and not out["error"]
    assert any("datastandardsinnovation" in u and "2026q2" in u for u in asked)
    assert any("structureddata" in u and "2025q1" in u for u in asked)


def test_a_rate_limit_stops_the_run_and_keeps_the_day_to_do(tmp_path):
    def get(url, headers=None):
        raise events.Blocked("the SEC is limiting requests; trying again next hour")

    sec = events.Sec("me@example.com", get=get, download=lambda u, p, h: make_form345(p))
    sec_wait = events.SEC_GAP_S
    events.SEC_GAP_S = 0
    try:
        out = events.refresh_insiders(str(tmp_path), sec, {320193: "AAPL"}, date(2026, 10, 16), 1_771_000_000)
    finally:
        events.SEC_GAP_S = sec_wait
    assert out["error"] == "the SEC is limiting requests; trying again next hour"
    assert json.load(open(tmp_path / "insiders.json"))["days"] == []
