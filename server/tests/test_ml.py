import json
import os
import subprocess
import sys
from datetime import datetime

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ["TRADE_NO_SCHEDULER"] = "1"

import ml  # noqa: E402
import service  # noqa: E402


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(service, "STATE_FILE", str(tmp_path / "trade.json"))
    yield


@pytest.fixture(scope="module")
def dataset():
    out = subprocess.run(["node", os.path.join(HERE, "make_dataset.mjs"), "8"], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def rows_of(data, idx):
    return [{"x": [None if v != v else float(v) for v in data.x[i]], "seq": data.seq[i].tolist()} for i in idx]


def js_probs(models, rows):
    """Runs the app's own ml.js on the exported models."""
    script = """
import { lgbmProbability, lstmProbability } from '%s';
let s = '';
for await (const c of process.stdin) s += c;
const { models, rows } = JSON.parse(s);
process.stdout.write(JSON.stringify(rows.map(r => [
  lgbmProbability(models.lgbm, r.x.map(v => (v === null ? NaN : v))),
  models.lstm ? lstmProbability(models.lstm, r.seq) : null,
])));
""" % ("file://" + os.path.join(os.path.dirname(HERE), "js", "ml.js"))
    out = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps({"models": models, "rows": rows}), capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_tree_export_flattens_nodes_and_leaves():
    tree = {"split_index": 0, "split_feature": 2, "threshold": 0.5, "decision_type": "<=", "default_left": True, "missing_type": "NaN",
            "left_child": {"leaf_index": 0, "leaf_value": -0.1},
            "right_child": {"split_index": 1, "split_feature": 0, "threshold": -1.0, "decision_type": "<=", "default_left": False, "missing_type": "None",
                            "left_child": {"leaf_index": 1, "leaf_value": 0.2}, "right_child": {"leaf_index": 2, "leaf_value": 0.3}}}
    out = ml.export_tree(tree)
    assert out == {"nodes": [[2, 0.5, -1, 1, 1, 2], [0, -1.0, -2, -3, 0, 0]], "leaves": [-0.1, 0.2, 0.3]}
    assert ml.export_tree({"leaf_value": 0.4}) == {"nodes": [], "leaves": [0.4]}


def fake_rows(n, keys=("a", "b")):
    return [{"key": k, "t": t, "x": [t, None], "seq": [[0, 0]], "y": t % 2, "ret": 0} for k in keys for t in range(n)]


def test_split_is_by_time_and_drops_rows_that_see_the_test_period():
    data = ml.to_data(fake_rows(100))
    assert data.x.shape == (200, 2) and data.x[0][1] != data.x[0][1]  # None becomes NaN
    cutoff, train, test = ml.split(data)
    assert cutoff == 70
    assert (test.t > cutoff).all() and len(test) == 2 * 29
    assert train.t.max() == cutoff - ml.TURN_HORIZON
    assert len(train) == 2 * (71 - ml.TURN_HORIZON)
    assert list(train.t) == sorted(train.t)


def test_hit_rate_counts_clear_calls_after_fees():
    out = ml.hit_rate([0.7, 0.3, 0.9, 0.52], [0.01, -0.01, 0.001, 0.05])  # the last call isn't clear enough
    assert out["n"] == 3 and out["hit"] == round(2 / 3, 4)
    # Votes are measured from the model's own middle: near-50/50 predictions still make calls.
    cal = ml.calibrate([0.44, 0.45, 0.46, 0.45, 0.47, 0.43])
    assert cal["center"] == 0.45 and 0.01 <= cal["scale"] <= 0.02
    near = ml.hit_rate([0.47, 0.43, 0.45], [0.01, -0.01, 0.05], cal)
    assert near["n"] == 2 and near["hit"] == 1
    assert ml.hit_rate([0.47, 0.43], [0.01, -0.01])["n"] == 0  # a fixed 50% midpoint sees no clear calls
    table = ml.outcomes([0.47, 0.43, 0.45, 0.46], [0.01, -0.02, 0.05, 0.03], cal)
    assert [b["n"] for b in table] == [1, 0, 1, 1, 1]
    assert table[0]["ret"] == -0.02 and table[4]["up"] == 1 and sum(b["n"] for b in table) == 4
    assert ml.usable({"hit": 0.55, "n": 200}) and not ml.usable({"hit": 0.55, "n": 199}) and not ml.usable({"hit": 0.5, "n": 999})


def test_training_scores_the_test_period_and_js_predicts_the_same(dataset):
    data = ml.to_data(dataset["rows"])
    models = ml.train_models(data, dataset["features"], "1D", dataset["symbols"], now=123)
    assert models["trainedAt"] == 123 and models["symbols"] == 8
    times = sorted(r["t"] for r in dataset["rows"])
    assert times[0] < models["cutoff"] < times[-1]
    for name in ("lgbm", "lstm"):
        t = models[name]["test"]
        assert t["rows"] == models["testRows"] and 0 <= t["hit"] <= 1 and "usable" in t
        assert 0 < models[name]["center"] < 1 and models[name]["scale"] > 0 and t["n"] > 0
        assert sum(b["n"] for b in models[name]["outcomes"]) == t["rows"]
    assert models["lgbm"]["features"] == dataset["features"] and models["lgbm"]["trees"]
    # The trending series are learnable: the trees should beat a coin flip.
    assert models["lgbm"]["test"]["hit"] > 0.5
    # Turning-point models: measured against how often the outcome happens anyway.
    for name in ml.TURN_MODELS:
        m = models[name]
        assert m["trees"] and m["stopAtr"] == 2 and m["takeAtr"] == 3
        assert 0 <= m["test"]["base"] <= 1 and "usable" in m["test"]
        assert m["test"]["usable"] == (m["test"]["n"] >= ml.MIN_N and m["test"]["hit"] >= m["test"]["base"] + ml.TURN_EDGE)
    assert ml.summary(models)["bottom"] == models["bottom"]["test"]

    # The phone and the server run the exported JSON in JavaScript; it must match Python.
    idx = list(range(len(data) - 200, len(data)))
    sample = data.take(idx)
    cutoff, train, _ = ml.split(data)
    booster, best, lgbm = ml.train_lgbm(train, dataset["features"])
    net, lstm = ml.train_lstm(train, epochs=2)
    js = js_probs({"lgbm": lgbm, "lstm": lstm}, rows_of(data, idx))
    py_lgbm = booster.predict(sample.x, num_iteration=best).tolist()
    py_lstm = ml.lstm_probs(net, sample.seq)
    assert max(abs(a[0] - b) for a, b in zip(js, py_lgbm)) < 1e-5
    assert max(abs(a[1] - b) for a, b in zip(js, py_lstm)) < 1e-5

    ml.save_models("1D", models)
    assert ml.load_models("1D")["cutoff"] == models["cutoff"]
    assert ml.summary(models)["lgbm"] == models["lgbm"]["test"]


def test_too_little_history_is_a_clear_error():
    with pytest.raises(ValueError, match="Not enough history"):
        ml.train_models(ml.to_data(fake_rows(50)), ["f", "g"], "1D")
    with pytest.raises(ValueError, match="No training data"):
        ml.train_models(ml.to_data([]), ["f"], "1D")


def test_engine_streams_the_dataset_to_python():
    """The real engine's dataset mode, read line by line (no symbols, so no network)."""
    header, data = ml.load_dataset({"tf": "1D", "items": [], "settings": {"buyAt": 40, "sellAt": -40}}, timeout=60)
    assert header["tf"] == "1D" and len(header["features"]) == 41 and header["symbols"] == 0
    assert len(data) == 0


def test_train_run_trains_each_timeframe_and_resets_weights(monkeypatch):
    service.set_profile({"watchlist": [{"type": "stock", "symbol": "AAPL"}], "holdings": [], "settings": {"alertTf": "1h"}})
    service.update_state(lambda st: st.update(weights={"x": 1}, marketWeights={"y": 1}))
    jobs = []

    def trainer(job, timeout):
        jobs.append(job)
        if job["tf"] == "1h":
            raise RuntimeError("Yahoo down")
        return {"tf": job["tf"], "lgbm": {"hit": 0.55}}

    res = service.run_train("manual", trainer=trainer)
    assert [j["tf"] for j in jobs] == ["1h", "1D", "15m", "1W"]  # every timeframe, the alert one first
    assert jobs[0]["items"] == [{"type": "stock", "symbol": "AAPL", "name": "AAPL"}] and jobs[0]["total"] == service.TRAIN_SYMBOLS
    assert res["1h"]["error"] == "Yahoo down" and res["1D"]["lgbm"]["hit"] == 0.55
    st = service.load_state()
    assert st["training"]["results"]["1D"]["tf"] == "1D" and st["weights"] == {} and st["marketWeights"] == {}


def test_training_schedule(monkeypatch):
    tz = service.tz()
    monkeypatch.setattr(service, "TRAIN_AT", "Sun 03:00")
    wed = datetime(2026, 1, 7, 12, 0, tzinfo=tz)  # a Wednesday
    assert service.train_slot(wed).isoformat().startswith("2026-01-04T03:00")
    assert service.next_train_at(wed).startswith("2026-01-11T03:00")
    assert service.train_slot(datetime(2026, 1, 4, 2, 0, tzinfo=tz)).isoformat().startswith("2025-12-28T03:00")
    monkeypatch.setattr(service, "TRAIN_AT", "nonsense")
    assert service.train_schedule() == (6, 3, 0)

    assert service.train_due(service.load_state(), wed) is None  # nothing synced yet
    service.set_profile({"watchlist": [], "holdings": [], "settings": {"alertTf": "1D"}})
    slot = service.train_due(service.load_state(), wed)
    assert slot.startswith("2026-01-04T03:00")
    service.update_state(lambda st: st.update(lastTrainSlot=slot, training={"lastRunAt": service.now_ms(), "results": {}}))
    assert service.train_due(service.load_state(), wed) is None  # failed just now: wait
    ml.save_models("1D", {"cutoff": 1})
    service.update_state(lambda st: st.update(training={"lastRunAt": 0, "results": {}}))
    assert service.train_due(service.load_state(), wed)  # other timeframes still have no models
    for tf in ("15m", "1h", "1W"):
        ml.save_models(tf, {"cutoff": 1})
    service.update_state(lambda st: st.update(training={"lastRunAt": 0, "results": {}}))
    assert service.train_due(service.load_state(), wed) is None  # has models, week not over
    assert service.train_due(service.load_state(), datetime(2026, 1, 11, 3, 5, tzinfo=tz)).startswith("2026-01-11T03:00")


def test_models_reach_the_engine_and_the_app(monkeypatch):
    import main
    from fastapi.testclient import TestClient
    monkeypatch.setattr(main, "API_KEY", "secret")
    service.set_profile({"watchlist": [{"type": "stock", "symbol": "AAPL"}], "holdings": [], "settings": {"alertTf": "1D"}})
    service.add_subscription({"endpoint": "e", "keys": {}})
    ml.save_models("1D", {"tf": "1D", "cutoff": 9, "trainedAt": 5, "lgbm": {"trees": [], "test": {"hit": 0.6, "n": 300}}, "lstm": {"test": {"hit": 0.4, "n": 300}}})
    jobs = []
    service.run_watch(engine=lambda job, t: jobs.append(job) or {"signals": {}, "alerts": [], "holdingsAlerted": {}, "weights": {}, "errors": {}})
    assert jobs[0]["models"]["cutoff"] == 9
    c = TestClient(main.app)
    key = {"X-API-Key": "secret"}
    assert c.get("/models", headers=key).json()["models"]["1D"]["trainedAt"] == 5
    status = c.get("/status", headers=key).json()
    assert status["models"]["1D"]["lgbm"]["hit"] == 0.6 and "trees" not in status["models"]["1D"]
    assert "nextAt" in status["training"]
    assert c.get("/models").status_code == 401


def fake_filter(n, seed=1, years=3):
    """Trade filter rows where feature 0 tells winners from losers (with noise)."""
    import numpy as np
    rng = np.random.default_rng(seed)
    t = np.sort(rng.integers(0, years * 365, n)) * 86400
    x = rng.normal(size=(n, 3))
    win = (x[:, 0] + rng.normal(scale=0.7, size=n) > 0.4).astype(np.float32)
    tp, sp, fee = np.full(n, 0.06), np.full(n, 0.04), np.full(n, 0.001)
    ret = np.where(win == 1, tp, -sp) - 2 * fee
    return ml.FilterData(np.array(["k"] * n, dtype=object), t, x, win, ret, tp, sp, fee)


def test_filter_test_passes_only_with_enough_trades_and_a_real_edge():
    import numpy as np
    f = fake_filter(1000)
    perfect = f.win * 0.98 + 0.01
    out = ml.filter_test(perfect, f)
    assert out["passed"] and out["kept"] == int(f.win.sum()) and out["keptWin"] == 1.0
    assert out["keptAvg"] > out["allAvg"] > out["skippedAvg"] and out["medianEv"] > 0
    blind = np.full(len(f), 0.45)  # keeps everything: no edge over all trades
    out = ml.filter_test(blind, f)
    assert not out["passed"] and out["kept"] == len(f) and out["why"]
    assert ml.filter_test(perfect[:200], f.take(np.arange(200)))["why"] == "too few test trades"
    assert ml.filter_test(np.zeros(len(f)), f)["why"] == "it kept too few trades"


def test_filter_trains_before_the_test_year_and_js_agrees():
    import numpy as np
    f = fake_filter(6000)
    model = ml.train_filter(f, ["a", "b", "c"])
    assert model and model["features"] == ["a", "b", "c"] and model["trees"]
    assert model["cutoff"] == int(f.t.max()) - ml.FILTER_TEST_DAYS * 86400
    test = f.take(np.flatnonzero(f.t > model["cutoff"]))
    assert model["testRows"] == len(test)
    assert model["trainRows"] == int((f.t <= model["cutoff"] - ml.FILTER_GAP_DAYS * 86400).sum())
    assert model["test"]["passed"], model["test"]
    # The phone and the server run the exported trees; their test must come out the same.
    rows = [{"x": [float(v) for v in r], "seq": [[0]]} for r in test.x]
    js = [p for p, _ in js_probs({"lgbm": model, "lstm": None}, rows)]
    assert ml.filter_test(js, test) == model["test"]
    assert ml.train_filter(fake_filter(500), ["a", "b", "c"]) is None
    assert ml.summary({"filter": model})["filter"] == model["test"]


def test_dataset_carries_trade_filter_rows(dataset):
    data = ml.to_data(dataset["rows"])
    assert dataset["filterFeatures"][-4:] == ["baseScore", "agree", "market", "crypto"]
    assert len(data.filt) > 0 and data.filt.x.shape[1] == len(dataset["filterFeatures"])
    assert set(data.filt.win.tolist()) <= {0.0, 1.0} and (data.filt.fee == 0.001).all()
    base = dataset["filterFeatures"].index("baseScore")
    assert (data.filt.x[:, base] >= 15).all()
