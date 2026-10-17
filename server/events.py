"""
Outside data for the opportunity setups (see js/setups.js), all free:

    insiders   SEC Form 4: officers' and directors' open-market purchases.
               History from the SEC's quarterly insider data sets (2 years),
               new filings from the SEC's daily filing index.
    earnings   Past earnings releases from each company's SEC filings (form
               8-K, item 2.02), upcoming dates from Nasdaq's earnings calendar,
               or about 91 days after the last release when Nasdaq has none.
    fng        The crypto Fear & Greed index (alternative.me), daily since 2018.
    funding    Perpetual funding rates from Kraken Futures, summed per day.

The SEC asks every program to name a contact in its requests: set SEC_CONTACT
(an email address) on the server. Without it the SEC sources are skipped.

Everything is saved in DATA_DIR/events/ and refreshed by refresh(): the
quick sources every hour, the per-company SEC and Nasdaq data once a day.
The parse_* functions are pure so the tests can feed them sample data.
"""
import csv
import io
import json
import logging
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger("trade-service")

SEC_CONTACT = os.environ.get("SEC_CONTACT", "").strip()
NEW_YORK = ZoneInfo("America/New_York")
DAY = 86400
KEEP_DAYS = 800             # insider history kept (2 years plus the 30-day window)
QUARTERS = 8                # quarterly insider data sets loaded (2 years)
DAILY_EVERY_S = 20 * 3600   # per-company SEC data and the Nasdaq calendar
CALENDAR_DAYS = 14          # how far ahead the Nasdaq calendar is read
SEC_GAP_S = 0.2             # 5 a second, well under the SEC's limit of 10

# Coins with a Kraken perpetual (Kraken calls Bitcoin XBT).
FUNDING_COINS = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "LINK", "DOT", "AVAX", "BCH", "XLM", "ATOM", "UNI", "TRX", "NEAR", "FIL", "AAVE"]
KRAKEN_NAME = {"BTC": "XBT"}

# The SEC moved the data sets from 2026q2 on; older quarters stay at the first address.
FORM345_URLS = [
    "https://www.sec.gov/files/datastandardsinnovation/data/insider-transactions-data-sets/{y}q{q}_form345.zip",
    "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/{y}q{q}_form345.zip",
]
DAILY_INDEX_URL = "https://www.sec.gov/Archives/edgar/daily-index/{y}/QTR{q}/form.{d}.idx"
ARCHIVE_URL = "https://www.sec.gov/Archives/{path}"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
NASDAQ_URL = "https://api.nasdaq.com/api/calendar/earnings?date={d}"
FNG_URL = "https://api.alternative.me/fng/?limit=0&format=json"
KRAKEN_URL = "https://futures.kraken.com/derivatives/api/v4/historicalfundingrates?symbol=PF_{s}USD"

BROWSER_HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Trade", "Accept": "application/json, text/plain, */*"}


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

class NotFound(Exception):
    pass


class Blocked(RuntimeError):
    """The SEC is limiting our requests; stop and try again next hour."""


def _http_error(url: str, e: urllib.error.HTTPError) -> Exception:
    # sec.gov answers 403, not 404, for a file that doesn't exist (a holiday's
    # index, say); its rate limit is a 403 page that says so.
    if e.code == 404:
        return NotFound(url)
    if e.code == 403 and "sec.gov" in url:
        try:
            body = e.read(4000).decode("utf-8", "replace").lower()
        except Exception:  # noqa: BLE001
            body = ""
        if "rate" in body or "automated" in body or "undeclared" in body:
            return Blocked("the SEC is limiting requests; trying again next hour")
        return NotFound(url)
    if e.code == 429:
        return Blocked(f"{urllib.parse.urlparse(url).netloc} is limiting requests")
    return RuntimeError(f"{urllib.parse.urlparse(url).netloc} answered {e.code}")


def http_get(url: str, headers: Optional[dict] = None, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers=headers or BROWSER_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.read()
    except urllib.error.HTTPError as e:
        raise _http_error(url, e) from e


def http_download(url: str, path: str, headers: dict, timeout: int = 300) -> None:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res, open(path, "wb") as f:
            while chunk := res.read(1 << 20):
                f.write(chunk)
    except urllib.error.HTTPError as e:
        raise _http_error(url, e) from e


class Sec:
    """SEC requests: named with the contact, and spaced under 10 a second."""

    def __init__(self, contact: str, get: Callable = http_get, download: Callable = http_download):
        self.headers = {"User-Agent": f"Trade app {contact}", "Accept": "*/*"}
        self._get, self._download, self._last = get, download, 0.0

    def _wait(self):
        gap = SEC_GAP_S - (time.monotonic() - self._last)
        if gap > 0:
            time.sleep(gap)
        self._last = time.monotonic()

    def get(self, url: str) -> bytes:
        self._wait()
        return self._get(url, self.headers)

    def download(self, url: str, path: str) -> None:
        self._wait()
        self._download(url, path, self.headers)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def day_start(ts: float) -> int:
    return int(ts // DAY * DAY)


def _date_sec(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def parse_sec_date(text: str) -> Optional[int]:
    """'02-JAN-2024', '2024-01-02' or '20240102' to UTC midnight in seconds."""
    text = (text or "").strip()
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%Y%m%d"):
        try:
            return _date_sec(datetime.strptime(text, fmt).date())
        except ValueError:
            continue
    return None


def _yes(v) -> bool:
    return str(v or "").strip().lower() in ("1", "true", "y", "yes")


def _num(v) -> float:
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def role_of(relationship: str, title: str) -> Optional[str]:
    """Officers and directors only; big outside holders don't count."""
    rel = (relationship or "").lower()
    if "officer" in rel:
        return (title or "Officer").strip()[:40] or "Officer"
    if "director" in rel:
        return "Director"
    return None


def _tsv(zf: zipfile.ZipFile, name: str) -> Iterable[dict]:
    match = next((n for n in zf.namelist() if n.upper().endswith(name)), None)
    if not match:
        return []
    with zf.open(match) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"), delimiter="\t")


def parse_form345(path: str, ciks: Dict[int, str]) -> List[dict]:
    """Open-market purchases (code P) by officers and directors of the given
    companies, from one quarterly insider data set (zip of TSV files)."""
    with zipfile.ZipFile(path) as zf:
        buys: Dict[str, float] = {}
        for r in _tsv(zf, "NONDERIV_TRANS.TSV"):
            if r.get("TRANS_CODE") == "P" and r.get("TRANS_ACQUIRED_DISP_CD", "A") == "A":
                value = _num(r.get("TRANS_SHARES")) * _num(r.get("TRANS_PRICEPERSHARE"))
                if value > 0:
                    buys[r["ACCESSION_NUMBER"]] = buys.get(r["ACCESSION_NUMBER"], 0) + value
        subs = {}
        for r in _tsv(zf, "SUBMISSION.TSV"):
            acc = r.get("ACCESSION_NUMBER")
            if acc in buys and str(r.get("DOCUMENT_TYPE", "4")).startswith("4"):
                cik = int(_num(r.get("ISSUERCIK")))
                filed = parse_sec_date(r.get("FILING_DATE", ""))
                if cik in ciks and filed:
                    subs[acc] = (ciks[cik], filed)
        out, seen = [], set()
        for r in _tsv(zf, "REPORTINGOWNER.TSV"):
            acc = r.get("ACCESSION_NUMBER")
            if acc not in subs or acc in seen:
                continue
            role = role_of(r.get("RPTOWNER_RELATIONSHIP", ""), r.get("RPTOWNER_TITLE", ""))
            if not role:
                continue
            seen.add(acc)  # a joint filing counts once, for its first owner
            symbol, filed = subs[acc]
            out.append({"symbol": symbol, "acc": acc, "filed": filed, "owner": str(r.get("RPTOWNERCIK", "")).lstrip("0"),
                        "name": (r.get("RPTOWNERNAME") or "").strip()[:60], "role": role, "value": round(buys[acc])})
        return out


def parse_daily_index(text: str) -> List[dict]:
    """Form 4 rows of an EDGAR daily form index: { cik, date, path }."""
    out = []
    for line in text.splitlines():
        if not line.startswith("4 "):
            continue
        m = re.search(r"\s(\d{1,10})\s+(\d{8})\s+(edgar/\S+)\s*$", line)
        if m:
            out.append({"cik": int(m.group(1)), "date": parse_sec_date(m.group(2)), "path": m.group(3)})
    return out


def _text(node, path: str) -> str:
    found = node.find(path) if node is not None else None
    return (found.text or "").strip() if found is not None and found.text else ""


def parse_form4(text: str) -> Optional[dict]:
    """A Form 4 filing (the full submission text or just its XML) to
    { issuer, owner, name, role, value } for its open-market purchases, or None."""
    m = re.search(r"<ownershipDocument>.*?</ownershipDocument>", text, re.S)
    if not m:
        return None
    try:
        doc = ET.fromstring(m.group(0))
    except ET.ParseError:
        return None
    rel = doc.find("reportingOwner/reportingOwnerRelationship")
    kinds = ",".join(k for k, tag in (("Officer", "isOfficer"), ("Director", "isDirector")) if _yes(_text(rel, tag)))
    role = role_of(kinds, _text(rel, "officerTitle"))
    if not role:
        return None
    value = 0.0
    for t in doc.findall("nonDerivativeTable/nonDerivativeTransaction"):
        if _text(t, "transactionCoding/transactionCode") != "P":
            continue
        if _text(t, "transactionAmounts/transactionAcquiredDisposedCode/value") not in ("", "A"):
            continue
        value += _num(_text(t, "transactionAmounts/transactionShares/value")) * _num(_text(t, "transactionAmounts/transactionPricePerShare/value"))
    if value <= 0:
        return None
    return {
        "issuer": int(_num(_text(doc, "issuer/issuerCik"))),
        "owner": _text(doc, "reportingOwner/reportingOwnerId/rptOwnerCik").lstrip("0"),
        "name": _text(doc, "reportingOwner/reportingOwnerId/rptOwnerName")[:60],
        "role": role,
        "value": round(value),
    }


def parse_acceptance(text: str) -> Optional[int]:
    """The SEC's acceptanceDateTime ('2024-02-01T16:30:42.000Z') is New York
    time despite the Z. Seconds since 1970."""
    m = re.match(r"(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})", text or "")
    if not m:
        return None
    local = datetime.strptime(f"{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}", "%Y-%m-%d %H:%M:%S").replace(tzinfo=NEW_YORK)
    return int(local.timestamp())


def parse_submissions(data: dict) -> List[int]:
    """Earnings releases (8-K item 2.02) from a company's SEC submissions."""
    recent = ((data or {}).get("filings") or {}).get("recent") or {}
    forms, items, accepted = recent.get("form", []), recent.get("items", []), recent.get("acceptanceDateTime", [])
    out = set()
    for form, item, at in zip(forms, items, accepted):
        if form in ("8-K", "8-K/A") and "2.02" in str(item).split(","):
            t = parse_acceptance(at)
            if t:
                out.add(t)
    # An amended or second filing the same day is the same release.
    days, releases = set(), []
    for t in sorted(out):
        if day_start(t) not in days:
            days.add(day_start(t))
            releases.append(t)
    return releases


def parse_nasdaq(data: dict, day: date) -> Dict[str, dict]:
    """Nasdaq's earnings calendar for one day: { symbol: { at, when } }."""
    rows = (((data or {}).get("data") or {}).get("rows")) or []
    out = {}
    for r in rows:
        symbol = str(r.get("symbol") or "").strip().upper().replace("/", ".")
        if not symbol:
            continue
        when = {"time-pre-market": "before the open", "time-after-hours": "after the close"}.get(r.get("time"), "")
        out[symbol] = {"at": _date_sec(day), "when": when}
    return out


def parse_fng(data: dict) -> List[list]:
    """Fear & Greed history as [[day seconds, value]], oldest first."""
    out = {}
    for r in (data or {}).get("data") or []:
        try:
            out[day_start(int(r["timestamp"]))] = int(r["value"])
        except (KeyError, TypeError, ValueError):
            continue
    return [[t, v] for t, v in sorted(out.items())]


def parse_kraken_funding(data: dict, now: Optional[float] = None) -> List[list]:
    """Kraken's hourly funding rates summed per day: [[day seconds, rate]].
    Today's partial day is left out."""
    today = day_start(now if now is not None else time.time())
    days: Dict[int, float] = {}
    for r in (data or {}).get("rates") or []:
        try:
            t = datetime.fromisoformat(str(r["timestamp"]).replace("Z", "+00:00")).timestamp()
            rate = float(r.get("relativeFundingRate", r.get("fundingRate")))
        except (KeyError, TypeError, ValueError):
            continue
        d = day_start(t)
        if d < today:
            days[d] = days.get(d, 0.0) + rate
    return [[d, round(v, 7)] for d, v in sorted(days.items())]


# ---------------------------------------------------------------------------
# Saved files
# ---------------------------------------------------------------------------

def _read(folder: str, name: str, default):
    try:
        with open(os.path.join(folder, name), "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return default


def _write(folder: str, name: str, data) -> None:
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(path + ".tmp", path)


def load_events(folder: str) -> dict:
    """What the engine's setups read: { insiders, earnings, fng, funding }."""
    ins = _read(folder, "insiders.json", {})
    earn = _read(folder, "earnings.json", {})
    insiders = {sym: [{k: p[k] for k in ("filed", "owner", "name", "role", "value")} for p in rows]
                for sym, rows in (ins.get("bySymbol") or {}).items()}
    return {
        "insiders": insiders,
        "earnings": earn.get("releases") or {},
        "fng": _read(folder, "fng.json", []),
        "funding": _read(folder, "funding.json", {}),
    }


def statuses(folder: str) -> dict:
    return _read(folder, "status.json", {})


def next_earnings(folder: str) -> Dict[str, dict]:
    return (_read(folder, "earnings.json", {}) or {}).get("next") or {}


def sp500_ciks(csv_path: str) -> Dict[int, str]:
    """CIK → symbol from the S&P 500 list saved with the server."""
    out = {}
    with open(csv_path, "r", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            try:
                out[int(r["CIK"])] = r["Symbol"].strip()
            except (KeyError, TypeError, ValueError):
                continue
    return out


# ---------------------------------------------------------------------------
# Refreshing
# ---------------------------------------------------------------------------

def quarters_back(today: date, n: int = QUARTERS) -> List[str]:
    """The last n finished quarters, newest first, as '2024q1'."""
    y, q = today.year, (today.month - 1) // 3 + 1
    out = []
    for _ in range(n):
        q -= 1
        if q == 0:
            y, q = y - 1, 4
        out.append(f"{y}q{q}")
    return out


def quarter_end(qid: str) -> date:
    y, q = int(qid[:4]), int(qid[-1])
    return (date(y + (q == 4), 1 if q == 4 else 3 * q + 1, 1)) - timedelta(days=1)


def _add_purchases(store: dict, rows: List[dict], now: float) -> int:
    by = store.setdefault("bySymbol", {})
    added = 0
    oldest = now - KEEP_DAYS * DAY
    for r in rows:
        lst = by.setdefault(r["symbol"], [])
        if any(p["acc"] == r["acc"] for p in lst):
            continue
        lst.append({k: r[k] for k in ("acc", "filed", "owner", "name", "role", "value")})
        added += 1
    for sym in list(by):
        by[sym] = sorted((p for p in by[sym] if p["filed"] >= oldest), key=lambda p: p["filed"])
        if not by[sym]:
            del by[sym]
    return added


def refresh_insiders(folder: str, sec: Sec, ciks: Dict[int, str], today: date, now: float, max_days: int = 60) -> dict:
    store = _read(folder, "insiders.json", {"quarters": [], "days": [], "bySymbol": {}})
    done_q = set(store.get("quarters", []))
    errors = []
    for qid in reversed(quarters_back(today)):
        if qid in done_q:
            continue
        tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
        tmp.close()
        try:
            for k, url in enumerate(FORM345_URLS):
                try:
                    sec.download(url.format(y=qid[:4], q=qid[-1]), tmp.name)
                    break
                except NotFound:
                    if k == len(FORM345_URLS) - 1:
                        raise
            _add_purchases(store, parse_form345(tmp.name, ciks), now)
            done_q.add(qid)
        except NotFound:
            errors.append(f"{qid} data set not published yet")
        except Blocked as e:
            errors.append(str(e))
            break
        except Exception as e:  # noqa: BLE001 - one bad quarter shouldn't stop the rest
            errors.append(f"{qid}: {e}")
        finally:
            os.unlink(tmp.name)
    store["quarters"] = sorted(done_q)
    # New filings after the newest quarter loaded, from the daily index.
    covered = max((quarter_end(q) for q in done_q), default=today - timedelta(days=45))
    start = max(covered + timedelta(days=1), today - timedelta(days=45))
    done_days = set(store.get("days", []))
    fetched = 0
    d = start
    while d <= today and fetched < max_days:
        key = d.strftime("%Y%m%d")
        if d.weekday() < 5 and key not in done_days:
            fetched += 1
            try:
                text = sec.get(DAILY_INDEX_URL.format(y=d.year, q=(d.month - 1) // 3 + 1, d=key)).decode("latin-1")
                rows = []
                for row in {r["path"]: r for r in parse_daily_index(text) if r["cik"] in ciks}.values():
                    try:
                        f4 = parse_form4(sec.get(ARCHIVE_URL.format(path=row["path"])).decode("utf-8", "replace"))
                    except Blocked:
                        raise  # the day stays to do, so no filing is skipped
                    except Exception as e:  # noqa: BLE001
                        logger.info("Form 4 %s: %s", row["path"], e)
                        continue
                    if f4 and f4["issuer"] in ciks:
                        acc = os.path.basename(row["path"]).rsplit(".", 1)[0]  # the accession number, as in the data sets
                        rows.append({**f4, "symbol": ciks[f4["issuer"]], "acc": acc, "filed": row["date"]})
                _add_purchases(store, rows, now)
                done_days.add(key)
            except NotFound:
                # Weekends and holidays have no index; today's appears in the evening.
                if (today - d).days >= 4:
                    done_days.add(key)
            except Blocked as e:
                errors.append(str(e))
                break
            except Exception as e:  # noqa: BLE001
                errors.append(f"index {key}: {e}")
        d += timedelta(days=1)
    store["days"] = sorted(k for k in done_days if k >= (today - timedelta(days=120)).strftime("%Y%m%d"))
    _write(folder, "insiders.json", store)
    count = sum(len(v) for v in store.get("bySymbol", {}).values())
    return {"ok": bool(done_q) or not errors, "count": count, "quarters": len(done_q), "error": "; ".join(errors[:3]) or None}


def refresh_earnings(folder: str, sec: Optional[Sec], ciks: Dict[int, str], today: date, now: float,
                     get: Callable = http_get) -> Dict[str, dict]:
    store = _read(folder, "earnings.json", {"releases": {}, "next": {}})
    status = {}
    if sec:
        errors, n = [], 0
        for cik, symbol in ciks.items():
            try:
                store["releases"][symbol] = parse_submissions(json.loads(sec.get(SUBMISSIONS_URL.format(cik=cik))))
                n += 1
            except Exception as e:  # noqa: BLE001
                errors.append(f"{symbol}: {e}")
        status["earnings"] = {"ok": n > 0, "count": n, "error": f"{len(errors)} companies failed, e.g. {errors[0]}" if errors else None}
    else:
        status["earnings"] = {"ok": False, "count": 0, "error": "Set SEC_CONTACT on the server to load earnings dates"}
    upcoming, errors = {}, []
    symbols = set(ciks.values())
    for k in range(CALENDAR_DAYS + 1):
        d = today + timedelta(days=k)
        if d.weekday() >= 5:
            continue
        try:
            rows = parse_nasdaq(json.loads(get(NASDAQ_URL.format(d=d.isoformat()), BROWSER_HEADERS)), d)
            upcoming.update({s: v for s, v in rows.items() if s in symbols and s not in upcoming})
        except Exception as e:  # noqa: BLE001
            errors.append(str(e))
    nxt = {s: {**v, "estimated": False} for s, v in upcoming.items()}
    # No calendar date: about 91 days after the last release.
    for symbol, rel in store["releases"].items():
        if symbol in nxt or not rel:
            continue
        guess = day_start(rel[-1]) + 91 * DAY
        if guess >= _date_sec(today) - DAY:
            nxt[symbol] = {"at": guess, "when": "", "estimated": True}
    store["next"] = nxt
    store["at"] = int(now * 1000)
    _write(folder, "earnings.json", store)
    status["calendar"] = {"ok": not errors or bool(upcoming), "count": len(upcoming), "error": errors[0] if errors else None}
    return status


def refresh_crowd(folder: str, now: float, get: Callable = http_get) -> Dict[str, dict]:
    status = {}
    try:
        fng = parse_fng(json.loads(get(FNG_URL, BROWSER_HEADERS)))
        if fng:
            _write(folder, "fng.json", fng)
        status["fng"] = {"ok": bool(fng), "count": len(fng), "error": None if fng else "no data"}
    except Exception as e:  # noqa: BLE001
        status["fng"] = {"ok": False, "count": 0, "error": str(e)}
    funding = _read(folder, "funding.json", {})
    errors = []
    for coin in FUNDING_COINS:
        try:
            rows = parse_kraken_funding(json.loads(get(KRAKEN_URL.format(s=KRAKEN_NAME.get(coin, coin)), BROWSER_HEADERS)), now)
            if rows:
                funding[coin] = rows
        except Exception as e:  # noqa: BLE001
            errors.append(f"{coin}: {e}")
    _write(folder, "funding.json", funding)
    status["funding"] = {"ok": bool(funding), "count": len(funding), "error": f"{len(errors)} coins failed, e.g. {errors[0]}" if errors else None}
    return status


def refresh(folder: str, ciks: Dict[int, str], now: Optional[float] = None, get: Callable = http_get,
            sec: Optional[Sec] = None, contact: Optional[str] = None) -> dict:
    """One refresh round. The quick sources always; the SEC and Nasdaq ones
    once a day. Returns and saves each source's status."""
    now = now if now is not None else time.time()
    today = datetime.fromtimestamp(now, NEW_YORK).date()
    contact = SEC_CONTACT if contact is None else contact
    sec = sec or (Sec(contact) if contact else None)
    status = statuses(folder)
    stamp = int(now * 1000)
    for k, v in refresh_crowd(folder, now, get).items():
        status[k] = {**v, "at": stamp}
    if sec:
        try:
            status["insiders"] = {**refresh_insiders(folder, sec, ciks, today, now), "at": stamp}
        except Exception as e:  # noqa: BLE001
            logger.exception("Insider refresh failed")
            status["insiders"] = {"ok": False, "count": 0, "error": str(e), "at": stamp}
    else:
        status["insiders"] = {"ok": False, "count": 0, "error": "Set SEC_CONTACT on the server to load insider filings", "at": stamp}
    last_daily = (status.get("earnings") or {}).get("at") or 0
    if stamp - last_daily >= DAILY_EVERY_S * 1000:
        for k, v in refresh_earnings(folder, sec, ciks, today, now, get).items():
            status[k] = {**v, "at": stamp}
    _write(folder, "status.json", status)
    return status


# ---------------------------------------------------------------------------
# Earnings warnings for what you hold
# ---------------------------------------------------------------------------

def trading_days_until(today: date, then: date) -> int:
    n, d = 0, today
    while d < then:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def earnings_warnings(nxt: Dict[str, dict], held: Iterable[str], today: date) -> List[dict]:
    """Alerts for held stocks that report within 2 trading days. `held` are
    keys like 'stock:AAPL'; each alert has an id so it is sent once."""
    out = []
    for key in sorted(set(held)):
        kind, _, symbol = key.partition(":")
        info = nxt.get(symbol)
        if kind != "stock" or not info:
            continue
        day = datetime.fromtimestamp(info["at"], timezone.utc).date()
        if day < today or trading_days_until(today, day) > 2:
            continue
        when = "today" if day == today else day.strftime("%A")
        guess = " (estimated from its last report)" if info.get("estimated") else ""
        timing = f" {info['when']}" if info.get("when") else ""
        out.append({
            "kind": "pre-earnings",
            "key": key,
            "id": f"pre-earnings:{key}:{day.isoformat()}",
            "title": f"{symbol} reports earnings {when}",
            "body": f"Earnings {day.strftime('%a %b %d')}{timing}{guess}. Prices can gap past a stop-loss on earnings news.",
            "hash": f"chart/stock/{symbol}",
        })
    return out
