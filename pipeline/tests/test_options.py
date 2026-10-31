"""Recording call options at the close (pipeline/options.py), against a real TQQQ chain saved
from the 2026-10-30 close. No network."""
import copy
import datetime as dt
import json
from pathlib import Path

import pytest

import build
import options

FIX = Path(__file__).parent / "fixtures" / "options-tqqq-2026-10-30.json"
CHAIN = json.loads(FIX.read_text())
TQQQ = {"symbol": "TQQQ", "dir": "data"}
PRICES = {"meta": {"as_of": "2026-10-30"}, "series": {"close": [66.29, 62.01]}}
D = dt.date.fromisoformat


def fake(chain=CHAIN, underlying=None, fail=None):
    """A stand-in for yfinance that answers from the saved chain."""
    def fetch(symbol):
        if fail:
            raise fail
        return chain["expirations"], chain["underlying"] if underlying is None else underlying, lambda e: chain["calls"][e]
    return fetch


def test_the_next_four_weeks_and_the_monthly_daily_expiries_skipped():
    # the saved list starts with Monday Nov 2 and Wednesday Nov 4 (daily expiries)
    got = options.choose_expiries(CHAIN["expirations"], D("2026-10-30"))
    assert [(e["date"], e["days"], e["monthly"]) for e in got] == [
        ("2026-11-06", 7, False), ("2026-11-13", 14, False), ("2026-11-20", 21, True), ("2026-11-27", 28, False)]


def test_a_monthly_beyond_four_weeks_is_added_if_within_45_days():
    # the day after October's monthly: four weeks reach Nov 13; November's monthly, Nov 20, is 35 days out
    fridays = ["2026-10-23", "2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27", "2026-12-18"]
    got = [e["date"] for e in options.choose_expiries(fridays, D("2026-10-16"))]
    assert got == ["2026-10-23", "2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"]
    # but not one 49 days out
    assert "2026-12-18" not in [e["date"] for e in options.choose_expiries(fridays, D("2026-10-30"))]


def test_monthly_is_the_week_of_the_third_friday_including_a_holiday_thursday():
    assert options.is_monthly(D("2026-11-20"))
    assert not options.is_monthly(D("2026-11-13"))
    assert options.is_monthly(D("2025-04-17"))  # Good Friday 2025 was the third Friday; options expired Thursday


def test_a_week_with_a_thursday_expiry_uses_it():
    got = options.choose_expiries(["2025-04-11", "2025-04-17", "2025-04-25"], D("2025-04-10"))
    assert [e["date"] for e in got] == ["2025-04-11", "2025-04-17", "2025-04-25"]


def test_the_real_chain_is_recorded_from_the_close_to_plus_40_percent():
    p = options.record(TQQQ, fake(), now=dt.datetime(2026, 10, 30, 20, 17, tzinfo=dt.timezone.utc), prices=PRICES)
    assert p["meta"] == {"symbol": "TQQQ", "as_of": "2026-10-30", "close": 62.01, "underlying": 62.01,
                         "fetched_utc": "2026-10-30T20:17:00Z", "source": "yfinance", "strikes": "calls from the close to +40%"}
    strikes = [c["strike"] for e in p["expiries"] for c in e["calls"]]
    assert min(strikes) >= 62.01 and max(strikes) <= 62.01 * 1.4
    nov20 = next(e for e in p["expiries"] if e["date"] == "2026-11-20")
    call = next(c for c in nov20["calls"] if c["strike"] == 67)
    # the worked example in docs/covered-calls-plan.md
    assert (call["bid"], call["ask"], call["open_interest"]) == (2.16, 2.52, 183)
    assert 0.5 < call["iv"] < 1.0


def test_a_missing_number_is_recorded_as_missing():
    chain = copy.deepcopy(CHAIN)
    row = next(r for r in chain["calls"]["2026-11-06"] if r["strike"] == 67)
    row["volume"] = float("nan")
    p = options.record(TQQQ, fake(chain), prices=PRICES)
    assert next(c for c in p["expiries"][0]["calls"] if c["strike"] == 67)["volume"] is None


@pytest.mark.parametrize("change, message", [
    (lambda c: None, None),  # the real chain passes
    (lambda c: c["calls"]["2026-11-13"].__setitem__(5, dict(c["calls"]["2026-11-13"][5], bid=99.0, ask=1.0, strike=70.0)), "is above its ask"),
    (lambda c: c["calls"]["2026-11-13"].__setitem__(5, dict(c["calls"]["2026-11-13"][5], bid=-0.1, strike=70.0)), "negative price"),
    (lambda c: [r.__setitem__("bid", 0.0) for e in c["calls"].values() for r in e], "has a bid"),
])
def test_a_broken_chain_is_stopped_with_the_reason(change, message):
    chain = copy.deepcopy(CHAIN)
    change(chain)
    if message is None:
        options.record(TQQQ, fake(chain), prices=PRICES)
    else:
        with pytest.raises(options.Stopped, match=message):
            options.record(TQQQ, fake(chain), prices=PRICES)


def test_options_from_a_different_close_are_stopped():
    with pytest.raises(options.Stopped, match="not within 1%"):
        options.record(TQQQ, fake(underlying=64.0), prices=PRICES)  # 3% away: another day's price


def test_an_expiry_on_or_before_the_close_is_stopped():
    with pytest.raises(options.Stopped, match="not after the close"):
        options.check({"meta": {"symbol": "TQQQ", "underlying": 62.01},
                       "expiries": [{"date": "2026-10-30", "calls": [{"strike": 63, "bid": 1, "ask": 1.1, "last": 1}]}]},
                      62.01, D("2026-10-30"))


def test_main_writes_the_file_and_keeps_the_previous_one_when_stopped(tmp_path, monkeypatch):
    lst = tmp_path / "tickers.json"
    lst.write_text(json.dumps({"default": "TQQQ", "tickers": [
        {"symbol": "TQQQ", "dir": "data", "benchmark": "QQQ"}, {"symbol": "QQQ", "dir": "data/qqq", "benchmark": "TQQQ"}]}))
    monkeypatch.setattr(build, "TICKERS", lst)
    out = tmp_path / "options.json"
    assert options.main(["--symbol", "TQQQ", "--out", str(out)], fake(), prices=PRICES) == 0
    first = out.read_text()
    assert json.loads(first)["meta"]["as_of"] == "2026-10-30"
    # a bad chain, and the source failing outright: exit 1, the file untouched
    assert options.main(["--symbol", "TQQQ", "--out", str(out)], fake(underlying=70.0), prices=PRICES) == 1
    assert options.main(["--symbol", "TQQQ", "--out", str(out)], fake(fail=RuntimeError("Invalid Crumb")), prices=PRICES) == 1
    assert out.read_text() == first
    assert options.main(["--symbol", "ZZZZ", "--out", str(out)], fake(), prices=PRICES) == 1


def test_a_ticker_options_file_sits_next_to_its_price_file():
    assert options.options_file({"symbol": "TQQQ", "dir": "data"}) == build.ROOT / "docs" / "data" / "options.json"
    assert options.options_file({"symbol": "QQQ", "dir": "data/qqq"}) == build.ROOT / "docs" / "data" / "qqq" / "options.json"
