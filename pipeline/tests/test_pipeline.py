import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fetch import (  # noqa: E402
    NY, DataError, drop_incomplete_session, drop_placeholder_rows, expected_last_session,
    fill_settled_close, from_csv, sessions_behind, validate,
)
from indicators import atr, bollinger, compute_all, drawdown, macd, rsi, sma  # noqa: E402
import build  # noqa: E402

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


def test_drop_placeholder_rows_removes_unsettled_bar(df):
    """Yahoo publishes the current session with null OHLC; it must not fail validation."""
    blank = pd.DataFrame({c: [np.nan] * 4 + [0.0] for c in df.columns}).iloc[[0]]
    blank.index = pd.to_datetime([df.index[-1] + pd.Timedelta(days=1)])
    polluted = pd.concat([df, blank])
    with pytest.raises(DataError, match="missing"):
        validate(polluted, "TQQQ")
    cleaned = drop_placeholder_rows(polluted)
    assert len(cleaned) == len(df)
    assert isinstance(validate(cleaned, "TQQQ"), list)


def test_drop_placeholder_rows_keeps_real_bars(df):
    assert len(drop_placeholder_rows(df)) == len(df)


@pytest.mark.parametrize("when,expected", [
    ("2026-09-18 20:28", "2026-09-18"),  # Friday evening, after the close
    ("2026-09-18 09:00", "2026-09-17"),  # Friday morning, before it
    ("2026-09-19 12:00", "2026-09-18"),  # Saturday  -> Friday
    ("2026-09-20 12:00", "2026-09-18"),  # Sunday    -> Friday
    ("2026-09-21 09:00", "2026-09-18"),  # Monday before the close -> Friday
    ("2026-09-21 20:30", "2026-09-21"),  # Monday evening
])
def test_expected_last_session(when, expected):
    now = dt.datetime.fromisoformat(when).replace(tzinfo=NY)
    assert expected_last_session(now).isoformat() == expected


def test_sessions_behind_counts_weekdays_only():
    assert sessions_behind(dt.date(2026, 9, 17), dt.date(2026, 9, 17)) == 0
    assert sessions_behind(dt.date(2026, 9, 17), dt.date(2026, 9, 18)) == 1
    assert sessions_behind(dt.date(2026, 9, 17), dt.date(2026, 9, 21)) == 2  # weekend skipped
    assert sessions_behind(dt.date(2026, 9, 18), dt.date(2026, 9, 20)) == 0  # weekend only


# Yahoo leaves the newest bar's close null for a while after the bell while already
# reporting it in the quote summary. These cover filling it back in safely.
SETTLED_META = {
    "regularMarketPrice": 78.91,
    "regularMarketTime": int(dt.datetime(2026, 9, 21, 16, 0, tzinfo=NY).timestamp()),
}


def _lagging_bar(close=np.nan, adjclose=np.nan, volume=53473068):
    return pd.DataFrame(
        {"open": [71.92, 74.85], "high": [72.78, 79.49], "low": [70.81, 74.84],
         "close": [72.64, close], "volume": [40624600, volume], "adjclose": [72.64, adjclose]},
        index=pd.to_datetime(["2026-09-18", "2026-09-21"]),
    )


def test_fill_settled_close_after_the_bell():
    out = fill_settled_close(_lagging_bar(), SETTLED_META,
                             dt.datetime(2026, 9, 21, 20, 35, tzinfo=NY))
    assert out["close"].iloc[-1] == pytest.approx(78.91)
    assert out["adjclose"].iloc[-1] == pytest.approx(78.91)  # newest bar needs no adjustment


def test_fill_settled_close_next_morning():
    out = fill_settled_close(_lagging_bar(), SETTLED_META,
                             dt.datetime(2026, 9, 22, 7, 30, tzinfo=NY))
    assert out["close"].iloc[-1] == pytest.approx(78.91)


def test_fill_settled_close_refuses_mid_session():
    """An in-progress price must never be written as a close."""
    live = dict(SETTLED_META,
                regularMarketTime=int(dt.datetime(2026, 9, 21, 11, 0, tzinfo=NY).timestamp()))
    out = fill_settled_close(_lagging_bar(), live,
                             dt.datetime(2026, 9, 21, 11, 0, tzinfo=NY))
    assert pd.isna(out["close"].iloc[-1])


def test_fill_settled_close_refuses_when_summary_is_a_different_session():
    stale = dict(SETTLED_META,
                 regularMarketTime=int(dt.datetime(2026, 9, 18, 16, 0, tzinfo=NY).timestamp()))
    out = fill_settled_close(_lagging_bar(), stale,
                             dt.datetime(2026, 9, 21, 20, 35, tzinfo=NY))
    assert pd.isna(out["close"].iloc[-1])


def test_fill_settled_close_refuses_an_incomplete_bar():
    out = fill_settled_close(_lagging_bar(volume=np.nan), SETTLED_META,
                             dt.datetime(2026, 9, 21, 20, 35, tzinfo=NY))
    assert pd.isna(out["close"].iloc[-1])


def test_fill_settled_close_leaves_a_real_close_alone():
    out = fill_settled_close(_lagging_bar(close=77.0, adjclose=77.0), SETTLED_META,
                             dt.datetime(2026, 9, 21, 20, 35, tzinfo=NY))
    assert out["close"].iloc[-1] == pytest.approx(77.0)


# --------------------------------------------------------------- revised sessions
def _published(df, last_close=None, last_vol=None):
    """A minimal tqqq.json-shaped dict built from `df`, optionally with the newest
    bar's close or volume nudged to stand in for a value the source has since moved."""
    close = [float(v) for v in df["close"]]
    vol = [float(v) for v in df["volume"]]
    if last_close is not None:
        close[-1] = last_close
    if last_vol is not None:
        vol[-1] = last_vol
    return {
        "meta": {"as_of": df.index[-1].date().isoformat()},
        "dates": [d.date().isoformat() for d in df.index],
        "series": {
            "open": [float(v) for v in df["open"]], "high": [float(v) for v in df["high"]],
            "low": [float(v) for v in df["low"]], "close": close, "volume": vol,
        },
    }


def test_revised_fields_silent_when_nothing_moved(df):
    assert build.revised_fields(_published(df), df, df) == []


def test_revised_fields_catches_a_corrected_close(df):
    published = _published(df, last_close=float(df["close"].iloc[-1]) * 1.002)  # 20bp off
    moved = build.revised_fields(published, df, df)
    assert len(moved) == 1 and moved[0].startswith("close ")


def test_revised_fields_ignores_sub_tolerance_price_noise(df):
    # a hair under the 2bp threshold: different sources rounding, not a correction
    published = _published(df, last_close=float(df["close"].iloc[-1]) * 1.0001)
    assert build.revised_fields(published, df, df) == []


def test_revised_fields_ignores_the_usual_volume_trickle(df):
    published = _published(df, last_vol=float(df["volume"].iloc[-1]) * 1.01)  # 1%
    assert build.revised_fields(published, df, df) == []


def test_revised_fields_catches_a_volume_restatement(df):
    published = _published(df, last_vol=float(df["volume"].iloc[-1]) * 1.05)  # 5%
    moved = build.revised_fields(published, df, df)
    assert len(moved) == 1 and moved[0].startswith("volume ")


def test_revised_fields_only_looks_at_the_newest_bar(df):
    published = _published(df)
    published["series"]["close"][5] = 1.0  # an old bar, wildly wrong
    assert build.revised_fields(published, df, df) == []


def test_revised_fields_skips_a_payload_that_ends_earlier(df):
    published = _published(df.iloc[:-1])  # published through the previous session
    assert build.revised_fields(published, df, df) == []


def test_build_republishes_a_revised_session(tmp_path, monkeypatch, df):
    """End to end: a second run exits 3, but republishes once the bar has moved."""
    import shutil
    src = tmp_path / "csv"
    src.mkdir()
    for sym in ("TQQQ", "QQQ"):
        shutil.copy(FIXTURE, src / f"{sym}.csv")
    out = tmp_path / "tqqq.json"
    argv = ["--csv-dir", str(src), "--out", str(out)]

    assert build.main(argv + ["--force"]) == 0
    assert build.main(argv) == 3, "unchanged data must not republish"

    # pretend the fixture's last session is the newest completed one, then tamper
    # the published close as a provider correction would
    last = df.index[-1].date()
    monkeypatch.setattr(build, "expected_last_session", lambda *a, **k: last)
    payload = json.loads(out.read_text())
    original = payload["series"]["close"][-1]
    payload["series"]["close"][-1] = round(original * 1.01, 4)
    out.write_text(json.dumps(payload))

    assert build.main(argv) == 0, "a moved close must republish"
    assert json.loads(out.read_text())["series"]["close"][-1] == pytest.approx(original)


def test_build_leaves_an_older_session_alone(tmp_path, monkeypatch, df):
    """Once the next session has closed, the published bar is no longer revisable."""
    import shutil
    src = tmp_path / "csv"
    src.mkdir()
    for sym in ("TQQQ", "QQQ"):
        shutil.copy(FIXTURE, src / f"{sym}.csv")
    out = tmp_path / "tqqq.json"
    argv = ["--csv-dir", str(src), "--out", str(out)]
    assert build.main(argv + ["--force"]) == 0

    later = df.index[-1].date() + dt.timedelta(days=7)
    monkeypatch.setattr(build, "expected_last_session", lambda *a, **k: later)
    payload = json.loads(out.read_text())
    payload["series"]["close"][-1] = round(float(payload["series"]["close"][-1]) * 1.01, 4)
    out.write_text(json.dumps(payload))

    assert build.main(argv) == 3, "a stale session must not be rewritten"


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
