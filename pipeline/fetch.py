"""Download and validate daily TQQQ / QQQ prices.

Sources, tried in order:
  1. yfinance (Yahoo Finance)                       - no key
  2. Yahoo chart API called directly with requests  - no key
  3. Tiingo           - needs TIINGO_API_KEY secret
  4. Alpha Vantage    - needs ALPHAVANTAGE_API_KEY secret (unadjusted prices)

All prices are adjusted for splits and dividends (OHLC scaled by adj_close / close).
"""
from __future__ import annotations

import datetime as dt
import logging
import os
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)
NY = ZoneInfo("America/New_York")
COLS = ["open", "high", "low", "close", "volume"]
UA = {"User-Agent": "Mozilla/5.0 (tqqq-support-dashboard)"}


class DataError(RuntimeError):
    """Raised when downloaded data fails validation."""


# --------------------------------------------------------------------------- sources
def _adjust(df: pd.DataFrame, adj_col: str = "adjclose") -> pd.DataFrame:
    """Scale OHLC by the adjusted/raw close ratio (split + dividend adjustment)."""
    if adj_col in df and df[adj_col].notna().all():
        f = df[adj_col] / df["close"]
        for c in ("open", "high", "low", "close"):
            df[c] = df[c] * f
    return df[COLS]


def from_yfinance(symbol: str, period: str = "2y") -> pd.DataFrame:
    import yfinance as yf

    df = yf.Ticker(symbol).history(period=period, interval="1d", auto_adjust=True, actions=False)
    if df.empty:
        raise DataError(f"yfinance returned no rows for {symbol}")
    df.index = pd.to_datetime(df.index.date)
    df = df.rename(columns=str.lower)
    return df[COLS]


def fill_settled_close(df: pd.DataFrame, meta: dict, now: dt.datetime | None = None) -> pd.DataFrame:
    """Fill the newest bar's close from the quote summary when the array lags.

    For a while after the bell Yahoo leaves `close` (and `adjclose`) null in the
    daily array while already reporting the same number as `meta.regularMarketPrice`.
    Dropping that bar is what kept this report a session behind. The fill only
    happens once the session is genuinely over, so an in-progress price is never
    written as a close, and only when the rest of the bar is complete.

    `regularMarketPrice` is the regular-session close; `fulldayPrice` (post-market)
    is deliberately not used.
    """
    if not len(df) or "close" not in df:
        return df
    price, ts = meta.get("regularMarketPrice"), meta.get("regularMarketTime")
    if price is None or ts is None or pd.notna(df["close"].iloc[-1]):
        return df
    last = df.index[-1]
    if dt.datetime.fromtimestamp(ts, NY).date() != last.date():
        return df  # the summary is about a different session than the last bar
    now = (now or dt.datetime.now(NY)).astimezone(NY)
    if now.date() == last.date() and now.time() < dt.time(16, 15):
        return df  # session still running — that price is not a close yet
    if df.loc[last, [c for c in COLS if c != "close"]].isna().any():
        return df  # rest of the bar is incomplete; let it be dropped instead
    df = df.copy()
    df.loc[last, "close"] = float(price)
    if "adjclose" in df and pd.isna(df.loc[last, "adjclose"]):
        df.loc[last, "adjclose"] = float(price)  # newest bar needs no adjustment
    log.info("filled %s close from the quote summary (%.2f)", last.date(), price)
    return df


def from_yahoo_chart(symbol: str, period: str = "2y") -> pd.DataFrame:
    import requests

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    r = requests.get(url, params={"range": period, "interval": "1d", "events": "div,split"},
                     headers=UA, timeout=30)
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    off = res["meta"].get("gmtoffset", 0)
    idx = pd.to_datetime([dt.datetime.utcfromtimestamp(t + off).date() for t in res["timestamp"]])
    df = pd.DataFrame({k: q[k] for k in COLS}, index=idx)
    df["adjclose"] = res["indicators"]["adjclose"][0]["adjclose"]
    df = fill_settled_close(df, res["meta"])
    return _adjust(df.dropna(subset=["close"]))


def from_tiingo(symbol: str, period: str = "2y") -> pd.DataFrame:
    import requests

    key = os.environ.get("TIINGO_API_KEY")
    if not key:
        raise DataError("TIINGO_API_KEY not set")
    start = (dt.date.today() - dt.timedelta(days=int(period.rstrip("y")) * 366)).isoformat()
    r = requests.get(f"https://api.tiingo.com/tiingo/daily/{symbol}/prices",
                     params={"startDate": start, "token": key}, headers=UA, timeout=30)
    r.raise_for_status()
    raw = pd.DataFrame(r.json())
    df = pd.DataFrame({
        "open": raw["adjOpen"], "high": raw["adjHigh"], "low": raw["adjLow"],
        "close": raw["adjClose"], "volume": raw["adjVolume"],
    })
    df.index = pd.to_datetime(pd.to_datetime(raw["date"]).dt.date)
    return df[COLS]


def from_alphavantage(symbol: str, period: str = "2y") -> pd.DataFrame:
    import requests

    key = os.environ.get("ALPHAVANTAGE_API_KEY")
    if not key:
        raise DataError("ALPHAVANTAGE_API_KEY not set")
    r = requests.get("https://www.alphavantage.co/query",
                     params={"function": "TIME_SERIES_DAILY", "symbol": symbol,
                             "outputsize": "full", "apikey": key}, headers=UA, timeout=30)
    r.raise_for_status()
    ts = r.json().get("Time Series (Daily)")
    if not ts:
        raise DataError(f"Alpha Vantage: {list(r.json())[:1]}")
    df = pd.DataFrame(ts).T.astype(float)
    df.columns = COLS
    df.index = pd.to_datetime(df.index)
    df = df.sort_index()
    cutoff = df.index[-1] - pd.DateOffset(years=int(period.rstrip("y")))
    return df[df.index > cutoff]


def from_csv(path: str) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"], index_col="date")
    return _adjust(df)


SOURCES = [("yfinance", from_yfinance), ("yahoo-chart", from_yahoo_chart),
           ("tiingo", from_tiingo), ("alphavantage", from_alphavantage)]


# --------------------------------------------------------------------------- cleaning
def drop_incomplete_session(df: pd.DataFrame, now: dt.datetime | None = None) -> pd.DataFrame:
    """Remove today's bar if the US market has not closed yet (before 16:15 New York time)."""
    now = (now or dt.datetime.now(NY)).astimezone(NY)
    if len(df) and df.index[-1].date() == now.date() and now.time() < dt.time(16, 15):
        return df.iloc[:-1]
    return df


def drop_placeholder_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Drop bars the source published with no price.

    Yahoo emits a row for a session it has not settled yet, with the OHLC null and
    volume zero. Left in place it fails validation and knocks out whichever source
    produced it, so every source gets the same treatment here.
    """
    if "close" not in df:
        return df
    return df[df["close"].notna()]


def expected_last_session(now: dt.datetime | None = None) -> dt.date:
    """The most recent weekday whose US close has passed.

    Market holidays are not known here, so this can point one session further
    forward than reality on a holiday. It is used to warn about staleness, never
    to reject data, so erring forward only risks a spurious note.
    """
    now = (now or dt.datetime.now(NY)).astimezone(NY)
    d = now.date()
    if now.time() < dt.time(16, 15):
        d -= dt.timedelta(days=1)
    while d.weekday() >= 5:  # Saturday = 5, Sunday = 6
        d -= dt.timedelta(days=1)
    return d


def sessions_behind(last: dt.date, expected: dt.date) -> int:
    """Count weekdays after `last` up to and including `expected`."""
    n, d = 0, last + dt.timedelta(days=1)
    while d <= expected:
        if d.weekday() < 5:
            n += 1
        d += dt.timedelta(days=1)
    return n


def validate(df: pd.DataFrame, symbol: str, max_jump: float = 0.40) -> list[str]:
    """Raise DataError on problems that would create fake levels; return soft warnings."""
    if len(df) < 260:
        raise DataError(f"{symbol}: only {len(df)} rows, need at least 260")
    if df[COLS].isna().any().any():
        raise DataError(f"{symbol}: missing values in {df[COLS].isna().sum().to_dict()}")
    if not df.index.is_monotonic_increasing or df.index.has_duplicates:
        raise DataError(f"{symbol}: dates are not strictly increasing")
    if (df[["open", "high", "low", "close"]] <= 0).any().any():
        raise DataError(f"{symbol}: non-positive prices")
    bad_hl = (df["high"] < df[["open", "close"]].max(axis=1) - 1e-6) | \
             (df["low"] > df[["open", "close"]].min(axis=1) + 1e-6)
    if bad_hl.sum() > 2:
        raise DataError(f"{symbol}: {int(bad_hl.sum())} bars with high/low outside open/close")
    zero = df.index[df["volume"] <= 0]
    if len(zero):
        raise DataError(f"{symbol}: zero volume on {[d.date().isoformat() for d in zero[:5]]}")
    jumps = df["close"].pct_change().abs()
    big = jumps[jumps > max_jump]
    if len(big):
        raise DataError(f"{symbol}: close moved >{max_jump:.0%} on "
                        f"{[d.date().isoformat() for d in big.index]} (bad split adjustment?)")
    warnings = []
    gaps = df.index.to_series().diff().dt.days
    for d, g in gaps[gaps > 4].items():  # long weekends are at most 4 days
        warnings.append(f"{symbol}: {int(g)}-day gap before {d.date()} (missing sessions?)")
    return warnings


def fetch(symbol: str, period: str = "2y", csv: str | None = None) -> tuple[pd.DataFrame, str, list[str]]:
    """Return (validated dataframe, source name, warnings).

    Sources are tried in order, but a source that validates is only accepted
    immediately when it reaches the most recent close. Otherwise the remaining
    sources are tried and the freshest result wins — one source lagging a
    session should not decide what gets published.
    """
    errors = []
    candidates = [("csv", lambda s, p: from_csv(csv))] if csv else SOURCES
    expected = expected_last_session()
    best: tuple[pd.DataFrame, str, list[str]] | None = None
    for name, fn in candidates:
        try:
            df = fn(symbol, period).astype(float).sort_index()
            df = df[~df.index.duplicated(keep="last")]
            df = drop_placeholder_rows(df)
            df = drop_incomplete_session(df)
            warnings = validate(df, symbol)
            log.info("%s: %d rows from %s, through %s", symbol, len(df), name, df.index[-1].date())
            if best is None or df.index[-1] > best[0].index[-1]:
                best = (df, name, warnings)
            if best[0].index[-1].date() >= expected:
                break  # current: no reason to call anything else
        except Exception as e:  # try the next source
            log.warning("%s via %s failed: %s", symbol, name, e)
            errors.append(f"{name}: {e}")
    if best is None:
        raise DataError(f"All sources failed for {symbol}: " + " | ".join(errors))
    if best[0].index[-1].date() < expected:
        log.warning("%s: freshest source (%s) ends %s, expected %s",
                    symbol, best[1], best[0].index[-1].date(), expected)
    return best
