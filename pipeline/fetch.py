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
    """Return (validated dataframe, source name, warnings)."""
    errors = []
    candidates = [("csv", lambda s, p: from_csv(csv))] if csv else SOURCES
    for name, fn in candidates:
        try:
            df = fn(symbol, period).astype(float).sort_index()
            df = df[~df.index.duplicated(keep="last")]
            df = drop_incomplete_session(df)
            warnings = validate(df, symbol)
            log.info("%s: %d rows from %s", symbol, len(df), name)
            return df, name, warnings
        except Exception as e:  # try the next source
            log.warning("%s via %s failed: %s", symbol, name, e)
            errors.append(f"{name}: {e}")
    raise DataError(f"All sources failed for {symbol}: " + " | ".join(errors))
