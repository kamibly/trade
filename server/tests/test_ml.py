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
  lstmProbability(models.lstm, r.seq),
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
    assert train.t.max() == cutoff - ml.HORIZON
    assert len(train) == 2 * (71 - ml.HORIZON)
    assert list(train.t) == sorted(train.t)


def test_hit_rate_counts_clear_calls_after_fees():
    out = ml.hit_rate([0.7, 0.3, 0.9, 0.52], [0.01, -0.01, 0.001, 0.05])  # the last call isn't clear enough
    assert out["n"] == 3 and out["hit"] == round(2 / 3, 4)
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
    assert models["lgbm"]["features"] == dataset["features"] and models["lgbm"]["trees"]
    # The trending series are learnable: the trees should beat a coin flip.
    assert models["lgbm"]["test"]["hit"] > 0.5

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
    assert [j["tf"] for j in jobs] == ["1D", "1h"]
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
