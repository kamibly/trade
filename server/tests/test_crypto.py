import os
import sys
import threading
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TRADE_API_KEY"] = "secret"
os.environ["TRADE_NO_SCHEDULER"] = "1"

import crypto  # noqa: E402
import service  # noqa: E402


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(service, "STATE_FILE", str(tmp_path / "trade.json"))
    yield


COINBASE = {"products": [
    {"product_id": "BTC-USD", "price": "65000", "approximate_quote_24h_volume": "900000000", "base_name": "Bitcoin", "status": "online"},
    {"product_id": "PEPE-USD", "price": "0.00001", "volume_24h": "50000000000", "base_name": "Pepe", "status": "online"},  # $500k
    {"product_id": "SOL-USD", "price": "150", "volume_24h": "100000", "base_name": "Solana", "status": "online"},  # $15M
    {"product_id": "SOL-EUR", "price": "140", "volume_24h": "1000000", "status": "online"},
    {"product_id": "USDT-USD", "price": "1", "volume_24h": "90000000", "status": "online"},
    {"product_id": "OLD-USD", "price": "3", "volume_24h": "9000000", "trading_disabled": True, "status": "online"},
]}
KRAKEN = {"error": [], "result": {
    "XXBTZUSD": {"c": ["65010", "1"], "v": ["1", "2000"], "p": ["1", "65000"]},
    "XDGUSD": {"c": ["0.15", "1"], "v": ["1", "80000000"], "p": ["1", "0.15"]},  # $12M of DOGE
    "ZEURZUSD": {"c": ["1.08", "1"], "v": ["1", "90000000"], "p": ["1", "1.08"]},
    "ETHUSDT": {"c": ["3000", "1"], "v": ["1", "90000"], "p": ["1", "3000"]},
    "XETHZUSD": {"c": ["3000", "1"], "v": ["1", "10000"], "p": ["1", "3000"]},
}}


def test_coinbase_and_kraken_make_one_list_of_tradable_coins():
    cb, kr = crypto.parse_coinbase(COINBASE), crypto.parse_kraken(KRAKEN)
    assert set(cb) == {"BTC", "PEPE", "SOL", "USDT"}
    assert cb["SOL"]["volume"] == 15_000_000
    assert crypto.kraken_symbol("XXBTZUSD") == "BTC" and crypto.kraken_symbol("XDGUSD") == "DOGE"
    assert crypto.kraken_symbol("ETHUSDT") is None and crypto.kraken_symbol("SOLUSD") == "SOL"
    assert set(kr) == {"BTC", "DOGE", "EUR", "ETH"}
    merged = crypto.merge(cb, kr)
    assert merged["BTC"]["price"] == 65000 and merged["BTC"]["on"] == ["Coinbase", "Kraken"]
    assert merged["BTC"]["volume"] == 900_000_000 + 2000 * 65000
    items = crypto.universe(merged)
    # Most traded first; no stablecoins, currencies or coins under $1M a day.
    assert [i["symbol"] for i in items] == ["BTC", "ETH", "SOL", "DOGE"]
    assert items[0] == {"type": "crypto", "symbol": "BTC", "name": "Bitcoin"}


def test_either_exchange_is_enough():
    def get(url):
        if "kraken" in url:
            raise RuntimeError("down")
        return COINBASE
    assert "BTC" in crypto.fetch_tickers(get)
    with pytest.raises(RuntimeError):
        crypto.fetch_tickers(lambda url: (_ for _ in ()).throw(RuntimeError("down")))


def test_fast_movers_are_measured_in_atrs_from_the_last_scan():
    last = {"crypto:BTC": {"entry": 60000, "atr": 2000}, "crypto:SOL": {"entry": 150, "atr": 10}, "stock:AAPL": {"entry": 1, "atr": 1}}
    assert crypto.fast_movers({"BTC": 63500, "SOL": 140, "AAPL": 9}, last) == ["crypto:BTC"]  # 1.75 ATR up; SOL only 1 ATR
    assert crypto.fast_movers({"BTC": 56000, "SOL": 134}, last) == ["crypto:BTC", "crypto:SOL"]


def test_crypto_scans_every_15_minutes_and_stocks_only_on_weekdays():
    q = 15 * 60_000
    base = 1_800_000_000_000 - (1_800_000_000_000 % q)
    st = {"profile": {"x": 1}, "lastCryptoSlot": service.crypto_slot(base + 61_000)}
    assert not service.crypto_due(st, base + 10 * 60_000)
    assert service.crypto_due(st, base + q + 61_000)  # the next quarter hour, a minute after the candle edge
    sat = datetime(2026, 10, 17, 10, 0, tzinfo=service.tz())
    assert service.due_market_slot(sat, None) is None
    assert service.due_market_slot(sat.replace(day=16), None) is not None
    assert datetime.fromisoformat(service.next_market_at(sat)).weekday() == 0  # Monday 9:45


PROFILE = {"watchlist": [], "holdings": [], "settings": {"quietHours": False}}


def summary(sym, action, score, entry=100.0, atr=5.0):
    return {"key": f"crypto:{sym}", "symbol": sym, "type": "crypto", "action": action, "score": score, "entry": entry, "atr": atr, "stop": entry - 10, "take": entry + 15, "candleTime": 1}


def test_crypto_scan_covers_the_coin_list_keeps_stock_results_and_rescores_fast_movers(monkeypatch):
    service.set_profile(PROFILE)
    monkeypatch.setattr(crypto, "fetch_tickers", lambda get=None: crypto.merge(crypto.parse_coinbase(COINBASE), crypto.parse_kraken(KRAKEN)))
    monkeypatch.setattr(service, "_spawn", lambda fn: fn())
    monkeypatch.setattr(crypto, "universe", lambda t, min_volume=0: [{"type": "crypto", "symbol": f"C{k}", "name": "x"} for k in range(25)])
    service.update_state(lambda st: st.update(
        marketActions={"stock:MMM": "buy", "crypto:OLD": "hold"}, marketWeights={"stock:MMM:1D": {"w": 1}},
        buyStarts={"stock:MMM": {"at": 1, "entry": 50}, "crypto:OLD": {"at": 1, "entry": 3}},
        scans={"stocks": {"at": 5, "scanned": 500, "total": 503, "buys": [{"key": "stock:MMM", "score": 60}], "sells": [],
                           "paperBuys": [{"id": "scan:stock:MMM:1", "setup": "scan", "key": "stock:MMM", "ev": 0.3}]}}))
    jobs = []

    def engine(job, timeout):
        jobs.append(job)
        if job["mode"] == "paper":
            return {"paper": {**job["paper"], "positions": [{"key": b["key"], "setup": "scan"} for b in job["scanBuys"]]}, "paperEvents": []}
        if job.get("only"):
            return {"at": 9, "scanned": 1, "total": 1, "buys": [summary("SOL", "buy", 55, entry=170)], "sells": [], "newBuys": ["crypto:SOL"], "newSells": [],
                    "actions": {"crypto:SOL": "buy"}, "weights": {}, "errors": {}, "alert": {"kind": "market", "setups": ["signal"], "title": "Crypto scan: 1 new buy idea", "body": ""},
                    "levels": {"crypto:SOL": {"entry": 170, "atr": 5}}, "buyStarts": {"crypto:SOL": {"at": 9, "entry": 170}}, "scanBuys": [{"id": "scan:crypto:SOL:1", "setup": "scan", "key": "crypto:SOL", "ev": 0.55}], "scanSells": []}
        return {"at": 7, "scanned": 2, "total": 2, "buys": [summary("BTC", "buy", 45)], "sells": [], "newBuys": [], "newSells": [],
                "actions": {"crypto:BTC": "buy", "crypto:SOL": "hold"}, "weights": {"crypto:BTC:1D": {"w": 2}}, "errors": {}, "alert": None,
                "levels": {"crypto:BTC": {"entry": 100, "atr": 5}, "crypto:SOL": {"entry": 150, "atr": 5}}, "buyStarts": {"crypto:BTC": {"at": 7, "entry": 100}}, "scanBuys": [], "scanSells": [],
                "opportunities": [], "records": {"crowd": {"n": 10, "wins": 6, "avg": 0.01}}, "counts": {}, "warnings": [], "digest": None}

    service.run_crypto(engine=engine)
    job = jobs[0]
    assert job["scope"] == "crypto" and len(job["items"]) == 25
    assert job["prev"] == {"crypto:OLD": "hold"} and job["weights"] == {}  # only its own symbols
    assert job["buyStarts"] == {"crypto:OLD": {"at": 1, "entry": 3}}
    st = service.load_state()
    assert st["marketActions"] == {"stock:MMM": "buy", "crypto:BTC": "buy", "crypto:SOL": "hold"}
    assert st["marketWeights"] == {"stock:MMM:1D": {"w": 1}, "crypto:BTC:1D": {"w": 2}}
    assert st["cryptoUniverse"]["items"] and st["cryptoLevels"]["crypto:SOL"]["entry"] == 150
    m = st["market"]
    assert m["scanned"] == 502 and [b["key"] for b in m["buys"]] == ["stock:MMM", "crypto:BTC"]
    assert m["stocksAt"] == 5 and m["cryptoAt"] == 7 and m["records"]["crowd"]["n"] == 10
    # The paper account is offered both markets' current ideas, not just this scan's.
    assert jobs[1]["mode"] == "paper" and [b["key"] for b in jobs[1]["scanBuys"]] == ["stock:MMM"]

    # SOL jumps 4 ATR: the minute watch scores just SOL, and the paper account buys it.
    moved = service.run_pulse(fetch=lambda: {"SOL": {"price": 170}, "BTC": {"price": 101}}, engine=engine)
    assert moved == ["crypto:SOL"]
    assert jobs[2]["only"] == ["crypto:SOL"] and jobs[3]["mode"] == "paper"
    assert [b["key"] for b in jobs[3]["scanBuys"]] == ["crypto:SOL", "stock:MMM"]
    st = service.load_state()
    assert [b["key"] for b in st["market"]["buys"]] == ["stock:MMM", "crypto:SOL", "crypto:BTC"]
    assert st["scans"]["crypto"]["scanned"] == 2  # still the full scan's numbers
    assert st["cryptoLevels"]["crypto:SOL"]["entry"] == 170 and st["marketActions"]["crypto:SOL"] == "buy"
    assert st["paper"]["positions"][0]["key"] == "crypto:SOL"
    # Where each buy idea began: the stock scan's kept, the full scan's replaced, the rescore's added.
    assert st["buyStarts"] == {"stock:MMM": {"at": 1, "entry": 50}, "crypto:BTC": {"at": 7, "entry": 100}, "crypto:SOL": {"at": 9, "entry": 170}}
    # The new level is the baseline: no move, no rescore.
    assert service.run_pulse(fetch=lambda: {"SOL": {"price": 171}}, engine=engine) == []


def test_run_now_starts_both_scans(monkeypatch):
    started = []
    monkeypatch.setattr(service, "run_market", lambda reason: started.append("stocks"))
    monkeypatch.setattr(service, "run_crypto", lambda reason: started.append("crypto"))
    monkeypatch.setattr(threading, "Thread", lambda target, args, daemon: type("T", (), {"start": lambda self: target(*args)})())
    service.run_in_background("market")
    assert sorted(started) == ["crypto", "stocks"]


def test_a_reset_account_buys_the_current_ideas_right_away(monkeypatch):
    service.set_profile(PROFILE)
    buy = {"id": "scan:crypto:SOL:9", "setup": "scan", "key": "crypto:SOL", "ev": 0.5}
    service.update_state(lambda st: st.update(scans={"crypto": {"at": 1, "paperBuys": [buy]}}, market={"opportunities": [{"id": "o", "key": "stock:AAPL"}]}))
    monkeypatch.setattr(service, "_spawn", lambda fn: fn())
    offered = []
    monkeypatch.setattr(service, "paper_opportunities", lambda opps, engine, buys, sells: offered.append((opps, buys)))
    service.reset_paper()
    assert offered == [([{"id": "o", "key": "stock:AAPL"}], [buy])]
