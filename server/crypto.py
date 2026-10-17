"""
The crypto the server scans around the clock: every coin traded against the
US dollar on Coinbase or Kraken (both open to Canadians) with at least
$1M traded a day, without stablecoins and currencies. Both exchanges give
every price and 24-hour volume in one request each, so the same two requests
also feed the every-minute fast-move watch.

The parse_* functions are pure so the tests can feed them sample data.
"""
import json
import urllib.request
from typing import Callable, Dict, List, Optional

COINBASE_PRODUCTS = "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT&limit=1000"
KRAKEN_TICKER = "https://api.kraken.com/0/public/Ticker"
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Trade", "Accept": "application/json"}

MIN_VOLUME_USD = 1_000_000
FAST_MOVE_ATR = 1.5   # a move this many ATRs since the last scan gets scored right away
NOT_COINS = {
    # Stablecoins and tokens that track a currency or gold never make a trade.
    "USDT", "USDC", "DAI", "BUSD", "TUSD", "USDE", "USDS", "FDUSD", "PYUSD", "USDD", "USD1", "SUSDE", "GUSD", "USDP",
    "EURC", "EURT", "EURQ", "USDQ", "RLUSD", "USDG", "PAXG", "XAUT", "TBTC", "WBTC", "CBBTC", "CBETH", "WETH", "STETH",
    # Kraken also lists currencies against the dollar.
    "USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "AED",
}
# Kraken's old names for a few coins.
KRAKEN_NAMES = {"XBT": "BTC", "XDG": "DOGE"}


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read())


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def parse_coinbase(data: dict) -> Dict[str, dict]:
    """{ symbol: { price, volume } } for tradable USD pairs (volume in dollars)."""
    out = {}
    for p in (data or {}).get("products") or []:
        pid = str(p.get("product_id") or "")
        if not pid.endswith("-USD") or p.get("is_disabled") or p.get("trading_disabled") or p.get("view_only"):
            continue
        if str(p.get("status") or "online").lower() not in ("online", ""):
            continue
        symbol = pid[:-4].upper()
        price = _num(p.get("price"))
        volume = _num(p.get("approximate_quote_24h_volume")) or _num(p.get("volume_24h")) * price
        if price > 0:
            out[symbol] = {"price": price, "volume": volume, "name": str(p.get("base_name") or symbol)[:60]}
    return out


def kraken_symbol(pair: str) -> Optional[str]:
    """XXBTZUSD -> BTC, SOLUSD -> SOL; None for anything not quoted in plain dollars."""
    if pair.endswith("ZUSD"):
        base = pair[:-4]
        if len(base) == 4 and base[0] in "XZ":
            base = base[1:]
    elif pair.endswith("USD") and "." not in pair:
        base = pair[:-3]
    else:
        return None
    base = base.upper()
    return KRAKEN_NAMES.get(base, base) or None


def parse_kraken(data: dict) -> Dict[str, dict]:
    """{ symbol: { price, volume } } from Kraken's all-pairs ticker."""
    out = {}
    for pair, t in ((data or {}).get("result") or {}).items():
        symbol = kraken_symbol(pair)
        if not symbol or not isinstance(t, dict):
            continue
        try:
            price = float(t["c"][0])
            volume = float(t["v"][1]) * float(t["p"][1])
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if price > 0:
            out[symbol] = {"price": price, "volume": volume, "name": symbol}
    return out


def merge(coinbase: Dict[str, dict], kraken: Dict[str, dict]) -> Dict[str, dict]:
    """One row per coin: Coinbase's price first (the scan's candles come from
    there first), volume added across both exchanges."""
    out = {}
    for symbol in set(coinbase) | set(kraken):
        a, b = coinbase.get(symbol), kraken.get(symbol)
        first = a or b
        out[symbol] = {
            "price": first["price"],
            "volume": (a or {}).get("volume", 0) + (b or {}).get("volume", 0),
            "name": (a or b)["name"],
            "on": [x for x, row in (("Coinbase", a), ("Kraken", b)) if row],
        }
    return out


def universe(tickers: Dict[str, dict], min_volume: float = MIN_VOLUME_USD) -> List[dict]:
    """Scan items, most traded first."""
    rows = [(s, t) for s, t in tickers.items() if s not in NOT_COINS and t["volume"] >= min_volume and s.isalnum()]
    rows.sort(key=lambda r: -r[1]["volume"])
    return [{"type": "crypto", "symbol": s, "name": t["name"]} for s, t in rows]


def fetch_tickers(get: Callable[[str], dict] = _get) -> Dict[str, dict]:
    """Every USD price and volume on Coinbase and Kraken. Either exchange may
    fail; both failing raises."""
    errors, coinbase, kraken = [], {}, {}
    try:
        coinbase = parse_coinbase(get(COINBASE_PRODUCTS))
    except Exception as e:  # noqa: BLE001
        errors.append(f"Coinbase: {e}")
    try:
        kraken = parse_kraken(get(KRAKEN_TICKER))
    except Exception as e:  # noqa: BLE001
        errors.append(f"Kraken: {e}")
    if not coinbase and not kraken:
        raise RuntimeError("; ".join(errors) or "no crypto prices")
    return merge(coinbase, kraken)


def fast_movers(prices: Dict[str, float], last: Dict[str, dict], min_atr: float = FAST_MOVE_ATR) -> List[str]:
    """Keys whose price moved at least `min_atr` ATRs from the last scan's.
    `prices` is { symbol: price }, `last` is { key: { entry, atr } }."""
    out = []
    for key, s in last.items():
        if not key.startswith("crypto:"):
            continue
        price = prices.get(key.split(":", 1)[1])
        entry, atr = _num(s.get("entry")), _num(s.get("atr"))
        if price and entry > 0 and atr > 0 and abs(price - entry) >= min_atr * atr:
            out.append(key)
    return out
