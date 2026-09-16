"""Technical indicators used by the dashboard. All functions take/return pandas Series."""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def wilder(s: pd.Series, n: int) -> pd.Series:
    """Wilder's smoothing (RMA), seeded with a simple average."""
    out = pd.Series(np.nan, index=s.index)
    vals = s.to_numpy(dtype=float)
    first = np.where(~np.isnan(vals))[0]
    if len(first) == 0 or len(vals) - first[0] < n:
        return out
    start = first[0] + n - 1
    avg = np.nanmean(vals[first[0]:start + 1])
    res = np.full(len(vals), np.nan)
    res[start] = avg
    for i in range(start + 1, len(vals)):
        avg = (avg * (n - 1) + vals[i]) / n
        res[i] = avg
    return pd.Series(res, index=s.index)


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    gain = wilder(d.clip(lower=0), n)
    loss = wilder((-d).clip(lower=0), n)
    rs = gain / loss
    out = 100 - 100 / (1 + rs)
    return out.where(loss != 0, 100.0).where(gain.notna())


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    line = ema(close, fast) - ema(close, slow)
    sig = line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return line, sig, line - sig


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0):
    mid = sma(close, n)
    sd = close.rolling(n, min_periods=n).std(ddof=0)
    return mid + k * sd, mid, mid - k * sd


def true_range(df: pd.DataFrame) -> pd.Series:
    pc = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1)
    return tr.max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return wilder(true_range(df), n)


def drawdown(close: pd.Series, n: int = 252) -> pd.Series:
    """Percent below the running n-session high (0 at a new high, negative otherwise)."""
    peak = close.rolling(n, min_periods=1).max()
    return (close / peak - 1) * 100


def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    c = df["close"]
    out = pd.DataFrame(index=df.index)
    for n in (20, 50, 200):
        out[f"sma{n}"] = sma(c, n)
    out["rsi14"] = rsi(c)
    out["macd"], out["macd_signal"], out["macd_hist"] = macd(c)
    out["bb_upper"], out["bb_mid"], out["bb_lower"] = bollinger(c)
    out["atr14"] = atr(df)
    out["vol_avg20"] = sma(df["volume"], 20)
    out["drawdown"] = drawdown(c)
    return out
