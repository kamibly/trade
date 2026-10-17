"""
trade-service: background alerts, the market scanner and holdings sync for
the Trade app (https://kamibly.github.io/Trade/).

Run with:
    uvicorn main:app --host 0.0.0.0 --port 8004

Required environment variables:
    TRADE_API_KEY   - shared secret the app sends as X-API-Key
    ALLOWED_ORIGIN  - the app's origin, default https://kamibly.github.io

Optional: see service.py (notification keys, time zone, scan times).
"""
import logging
import os
from typing import Optional

from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import service

logging.basicConfig(level=logging.INFO)

VERSION = "1.7.4"
API_KEY = os.environ.get("TRADE_API_KEY", "")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "https://kamibly.github.io")

app = FastAPI(title="Trade Service", version=VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN, "http://localhost:8090", "http://127.0.0.1:8090"],
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["X-API-Key", "Content-Type"],
)


def check_api_key(x_api_key: Optional[str]):
    if not API_KEY:
        raise HTTPException(status_code=503, detail="Server not set up yet (missing TRADE_API_KEY)")
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Wrong server key. Check it in the app's Settings.")


@app.on_event("startup")
def start():
    if os.environ.get("TRADE_NO_SCHEDULER") != "1":
        service.start_scheduler()


@app.get("/health")
def health():
    return {"status": "ok", "version": VERSION}


@app.get("/status")
def status(x_api_key: Optional[str] = Header(default=None)):
    """Everything the app's Settings shows about the server."""
    check_api_key(x_api_key)
    state = service.load_state()
    profile = state.get("profile") or {}
    market = state.get("market") or {}
    return {
        "version": VERSION,
        "pushEnabled": service.push_enabled(),
        "publicKey": service.VAPID_PUBLIC_KEY,
        "devices": len(state["subscriptions"]),
        "timezone": service.TZ_NAME,
        "synced": {"updatedAt": profile.get("updatedAt"), "watchlist": len(profile.get("watchlist", [])), "holdings": len(profile.get("holdings", []))},
        "watch": state["watch"],
        "watchEveryMinutes": service.WATCH_EVERY.get((profile.get("settings") or {}).get("alertTf"), 15),
        "market": {"lastRunAt": market.get("stocksAt") or market.get("at"), "scanned": market.get("stocksScanned", market.get("scanned")), "error": market.get("error"), "nextAt": service.next_market_at()},
        "crypto": {"lastRunAt": market.get("cryptoAt"), "scanned": market.get("cryptoScanned"), "total": market.get("cryptoTotal"), "everyMinutes": service.CRYPTO_SCAN_MINUTES,
                   "coins": len((state.get("cryptoUniverse") or {}).get("items") or []), "listError": (state.get("cryptoUniverse") or {}).get("error"),
                   "pulseAt": (state.get("pulse") or {}).get("lastRunAt"), "lastMoveAt": (state.get("pulse") or {}).get("lastMoveAt")},
        "scanTimes": service.scan_times(),
        "prices": {"lastRunAt": (state.get("prices") or {}).get("lastRunAt"), "everySeconds": service.PRICES_EVERY_MS // 1000},
        "models": service.model_summaries(),
        "training": {**(state.get("training") or {}), "nextAt": service.next_train_at()},
        "setups": service.setups_info(state),
    }


@app.get("/sync")
def get_sync(x_api_key: Optional[str] = Header(default=None)):
    """The watchlist, holdings and settings last saved by any phone."""
    check_api_key(x_api_key)
    return {"profile": service.load_state().get("profile")}


@app.put("/sync")
def put_sync(x_api_key: Optional[str] = Header(default=None), payload: dict = Body(...)):
    check_api_key(x_api_key)
    profile = service.set_profile(payload)
    return {"ok": True, "profile": profile}


@app.get("/signals")
def get_signals(x_api_key: Optional[str] = Header(default=None)):
    """Latest watchlist signals and the market scan, for the Signals tab."""
    check_api_key(x_api_key)
    state = service.load_state()
    models = {tf: s["trainedAt"] for tf, s in service.model_summaries().items()}
    return {"signals": state["signals"], "market": state.get("market"), "modelsAt": models, "setups": service.setups_info(state)}


@app.get("/paper")
def get_paper(x_api_key: Optional[str] = Header(default=None)):
    """The paper-trading account the server runs, with its latest trades."""
    check_api_key(x_api_key)
    state = service.load_state()
    return {"paper": state.get("paper"), "events": state.get("paperEvents", []), "prices": (state.get("prices") or {}).get("values", {}),
            "shadow": state.get("paperShadow"), "filterTrial": state.get("filterTrial"), "budgets": state.get("paperBudgets"),
            "skips": (state.get("paper") or {}).get("skips", {})}


@app.post("/paper/reset")
def post_paper_reset(x_api_key: Optional[str] = Header(default=None), payload: dict = Body(default={})):
    check_api_key(x_api_key)
    try:
        start = float(payload["start"]) if payload.get("start") else None
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Starting amount must be a number")
    if start is not None and not 100 <= start <= 10_000_000:
        raise HTTPException(status_code=400, detail="Starting amount must be between $100 and $10,000,000")
    return {"ok": True, "paper": service.reset_paper(start)}


@app.get("/models")
def get_models(x_api_key: Optional[str] = Header(default=None)):
    """The machine-learning models per timeframe, for the app to run on the phone."""
    check_api_key(x_api_key)
    return {"models": {tf: m for tf in sorted(service.TIMEFRAMES) if (m := service.load_models(tf))}}


@app.post("/run")
def post_run(x_api_key: Optional[str] = Header(default=None), payload: dict = Body(default={})):
    """Runs the watch, the market scan or model training now, in the background."""
    check_api_key(x_api_key)
    what = payload.get("what") if payload.get("what") in ("market", "crypto", "train", "events") else "watch"
    service.run_in_background(what)
    return {"ok": True, "started": what}


@app.post("/feedback")
def post_feedback(x_api_key: Optional[str] = Header(default=None), payload: dict = Body(...)):
    """Your rating of an alert: { setups: ["insider", ...], useful: true | false }."""
    check_api_key(x_api_key)
    try:
        return {"ok": True, "setups": service.add_feedback(payload.get("setups") or [], bool(payload.get("useful")))}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/setups/unmute")
def post_unmute(x_api_key: Optional[str] = Header(default=None), payload: dict = Body(...)):
    """Turns a muted setup's alerts back on."""
    check_api_key(x_api_key)
    try:
        return {"ok": True, "setups": service.unmute(str(payload.get("setup", "")))}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/push/subscribe")
def push_subscribe(x_api_key: Optional[str] = Header(default=None), payload: dict = Body(...)):
    check_api_key(x_api_key)
    if not service.push_enabled():
        raise HTTPException(status_code=503, detail="Notifications aren't set up on the server (missing VAPID keys)")
    try:
        devices = service.add_subscription(payload.get("subscription") or {}, payload.get("label", ""))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "devices": devices}


@app.post("/push/unsubscribe")
def push_unsubscribe(x_api_key: Optional[str] = Header(default=None), payload: dict = Body(...)):
    check_api_key(x_api_key)
    return {"ok": True, "devices": service.remove_subscription(str(payload.get("endpoint", "")))}


@app.post("/push/test")
def push_test(x_api_key: Optional[str] = Header(default=None), payload: dict = Body(default={})):
    check_api_key(x_api_key)
    sent = service.send_test(payload.get("endpoint") or None)
    if not sent:
        raise HTTPException(status_code=404, detail="This phone isn't registered for server alerts. Turn them off and on again.")
    return {"ok": True, "sent": sent}
