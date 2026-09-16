import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fetch import NY, DataError, drop_incomplete_session, from_csv, validate  # noqa: E402
from indicators import atr, bollinger, compute_all, drawdown, macd, rsi, sma  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "TQQQ.csv"


@pytest.fixture(scope="module")
def df():
    return from_csv(str(FIXTURE))


def test_fixture_loads_adjusted(df):
    assert list(df.columns) == ["open", "high", "low", "close", "volume"]
    assert len(df) > 400
    assert (df["high"] >= df["low"]).all()


def test_validate_passes_on_real_data(df):
    assert isinstance(validate(df, "TQQQ"), list)


def test_validate_catches_bad_split(df):
    bad = df.copy()
    bad.iloc[300:, :4] *= 2  # unadjusted 2:1 split
    with pytest.raises(DataError, match="bad split"):
        validate(bad, "TQQQ")


def test_validate_catches_zero_volume(df):
    bad = df.copy()
    bad.iloc[100, bad.columns.get_loc("volume")] = 0
    with pytest.raises(DataError, match="zero volume"):
        validate(bad, "TQQQ")


def test_validate_catches_missing_values(df):
    bad = df.copy()
    bad.iloc[50, 0] = np.nan
    with pytest.raises(DataError, match="missing"):
        validate(bad, "TQQQ")


def test_validate_flags_gaps(df):
    gappy = df.drop(df.index[200:206])
    assert any("gap" in w for w in validate(gappy, "TQQQ"))


def test_drop_incomplete_session():
    idx = pd.to_datetime(["2026-09-15", "2026-09-16"])
    d = pd.DataFrame({"close": [1, 2]}, index=idx)
    during = dt.datetime(2026, 9, 16, 12, 0, tzinfo=NY)
    after = dt.datetime(2026, 9, 16, 18, 0, tzinfo=NY)
    assert len(drop_incomplete_session(d, during)) == 1
    assert len(drop_incomplete_session(d, after)) == 2


def test_sma_and_bollinger():
    s = pd.Series(np.arange(1, 31, dtype=float))
    assert sma(s, 20).iloc[19] == pytest.approx(10.5)
    up, mid, lo = bollinger(s)
    assert mid.iloc[-1] == pytest.approx(20.5)
    assert up.iloc[-1] - mid.iloc[-1] == pytest.approx(mid.iloc[-1] - lo.iloc[-1])


def test_rsi_bounds_and_extremes():
    up = pd.Series(np.arange(1, 40, dtype=float))
    assert rsi(up).iloc[-1] == pytest.approx(100)
    down = pd.Series(np.arange(40, 1, -1, dtype=float))
    assert rsi(down).iloc[-1] == pytest.approx(0)


def test_rsi_known_value():
    # StockCharts ChartSchool RSI example; published 70.53 uses rounded averages, exact value is 70.46
    closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
              45.89, 46.03, 45.61, 46.28, 46.28]
    assert rsi(pd.Series(closes)).iloc[-1] == pytest.approx(70.464, abs=0.01)


def test_macd_hist_is_difference(df):
    line, sig, hist = macd(df["close"])
    assert (line - sig - hist).abs().max() < 1e-9


def test_atr_positive(df):
    a = atr(df)
    assert a.iloc[:13].isna().all()
    assert (a.dropna() > 0).all()


def test_drawdown_nonpositive(df):
    dd = drawdown(df["close"])
    assert dd.max() <= 1e-9 and dd.min() > -100


def test_compute_all_columns(df):
    out = compute_all(df)
    assert {"sma200", "rsi14", "macd_hist", "atr14", "vol_avg20", "drawdown"} <= set(out.columns)
    assert out["sma200"].notna().sum() == len(df) - 199
