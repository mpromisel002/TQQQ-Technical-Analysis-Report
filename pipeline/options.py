"""Record a ticker's call options at the close, for the covered-call card (docs/covered-calls-plan.md).

Step 1 of the plan: record only. Nothing on the page reads this file yet. After 2-3 weeks of
recorded chains, the "thin" (poor liquidity) thresholds are set from the record.

    python pipeline/options.py --symbol TQQQ

Writes <dir>/options.json next to the ticker's price file (on the market-data branch), with:
  - the expiries: the last expiry of each of the next 4 weeks, plus the nearest monthly
    (the week of the third Friday) within 45 days if it is not already one of them;
  - for each, the calls from the close up to +40%: bid, ask, last price, volume, open
    interest and implied volatility.

Checks before writing (the previous file is kept if any fails):
  - the underlying price Yahoo reports is within 1% of the close in the price file, so the
    options and the report describe the same close;
  - every expiry is after that close's date;
  - no negative price, and no bid above a non-zero ask;
  - at least one call has a bid.

Exit codes: 0 = written, 1 = stopped (the reason is printed).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import math
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402

log = logging.getLogger("options")

WEEKS = 4
MONTHLY_WITHIN_DAYS = 45
STRIKES_UP_TO = 1.40      # calls from the close to +40%
UNDERLYING_TOLERANCE = 0.01


class Stopped(Exception):
    """A check failed; the message says which, in plain words."""


def options_file(t: dict) -> Path:
    return build.ROOT / "docs" / t["dir"] / "options.json"


def is_monthly(day: dt.date) -> bool:
    """In the week of the month's third Friday (a Thursday expiry when that Friday is a holiday)."""
    first = day.replace(day=1)
    third_friday = first + dt.timedelta(days=(4 - first.weekday()) % 7 + 14)
    return day.isocalendar()[:2] == third_friday.isocalendar()[:2]


def choose_expiries(expirations: list[str], as_of: dt.date) -> list[dict]:
    """The last expiry of each of the next WEEKS weeks, plus the nearest monthly within
    MONTHLY_WITHIN_DAYS days. Daily expiries (Monday, Wednesday) are skipped: a covered call
    is usually sold for a week or more."""
    future = sorted(dt.date.fromisoformat(e) for e in expirations if dt.date.fromisoformat(e) > as_of)
    by_week: dict[tuple, dt.date] = defaultdict(lambda: dt.date.min)
    for d in future:
        week = d.isocalendar()[:2]
        by_week[week] = max(by_week[week], d)
    weekly = [by_week[w] for w in sorted(by_week)][:WEEKS]
    chosen = set(weekly)
    monthly = [d for d in future if is_monthly(d) and d == by_week[d.isocalendar()[:2]]
               and (d - as_of).days <= MONTHLY_WITHIN_DAYS]
    if monthly:
        chosen.add(monthly[0])
    return [{"date": d.isoformat(), "days": (d - as_of).days, "monthly": is_monthly(d)} for d in sorted(chosen)]


def _num(v):
    """A number from the source, or None for a missing one (NaN)."""
    if v is None:
        return None
    v = float(v)
    return None if math.isnan(v) else v


def calls_near(rows: list[dict], close: float) -> list[dict]:
    out = []
    for r in rows:
        strike = _num(r["strike"])
        if strike is None or not close <= strike <= close * STRIKES_UP_TO:
            continue
        vol, oi = _num(r.get("volume")), _num(r.get("openInterest"))
        out.append({
            "strike": strike,
            "bid": _num(r.get("bid")), "ask": _num(r.get("ask")), "last": _num(r.get("lastPrice")),
            "volume": None if vol is None else int(vol), "open_interest": None if oi is None else int(oi),
            "iv": None if _num(r.get("impliedVolatility")) is None else round(_num(r.get("impliedVolatility")), 4),
        })
    return sorted(out, key=lambda c: c["strike"])


def check(payload: dict, close: float, as_of: dt.date) -> None:
    sym, under = payload["meta"]["symbol"], payload["meta"]["underlying"]
    if under is None or abs(under / close - 1) > UNDERLYING_TOLERANCE:
        raise Stopped(f"{sym}: Yahoo's price for the options ({under}) is not within 1% of the "
                      f"report's {as_of} close ({close}); they would describe different days.")
    if not payload["expiries"]:
        raise Stopped(f"{sym}: no option expiries after {as_of}.")
    priced = 0
    for e in payload["expiries"]:
        if dt.date.fromisoformat(e["date"]) <= as_of:
            raise Stopped(f"{sym}: the expiry {e['date']} is not after the close it is recorded with ({as_of}).")
        for c in e["calls"]:
            if any(c[k] is not None and c[k] < 0 for k in ("bid", "ask", "last")):
                raise Stopped(f"{sym}: the {e['date']} ${c['strike']:g} call has a negative price.")
            if c["bid"] is not None and c["ask"] and c["bid"] > c["ask"]:
                raise Stopped(f"{sym}: the {e['date']} ${c['strike']:g} call's bid ({c['bid']}) is above its ask ({c['ask']}).")
            priced += bool(c["bid"])
    if not priced:
        raise Stopped(f"{sym}: no call from the close to +40% has a bid.")


def fetch(symbol: str):
    """(expirations, underlying price, function expiry -> list of call rows) from yfinance."""
    import yfinance as yf
    t = yf.Ticker(symbol)
    chain = lambda e: t.option_chain(e).calls.to_dict("records")
    return list(t.options), _num(t.fast_info["lastPrice"]), chain


def record(t: dict, fetch_fn=fetch, now=None, prices: dict | None = None) -> dict:
    prices = prices or json.loads(build.ticker_file(t).read_text())
    as_of = dt.date.fromisoformat(prices["meta"]["as_of"])
    close = prices["series"]["close"][-1]
    expirations, under, chain = fetch_fn(t["symbol"])
    expiries = choose_expiries(expirations, as_of)
    for e in expiries:
        e["calls"] = calls_near(chain(e["date"]), close)
    now = now or dt.datetime.now(dt.timezone.utc)
    payload = {
        "meta": {"symbol": t["symbol"], "as_of": as_of.isoformat(), "close": close,
                 "underlying": None if under is None else round(under, 4),
                 "fetched_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "yfinance",
                 "strikes": f"calls from the close to +{round((STRIKES_UP_TO - 1) * 100)}%"},
        "expiries": expiries,
    }
    check(payload, close, as_of)
    return payload


def main(argv=None, fetch_fn=fetch, prices: dict | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--symbol", required=True, help="ticker on the list")
    ap.add_argument("--out", help="output file (default: <dir>/options.json from the list)")
    args = ap.parse_args(argv)
    listing = build.load_tickers()
    t = next((x for x in listing["tickers"] if x["symbol"] == args.symbol.upper()), None)
    if t is None:
        log.error("STOPPED: %s is not on the ticker list.", args.symbol)
        return 1
    try:
        payload = record(t, fetch_fn, prices=prices)
    except Stopped as e:
        log.error("STOPPED: %s The previous options file is kept.", e)
        return 1
    except Exception as e:  # the source failed (network, Yahoo's cookie step, a changed reply)
        log.error("STOPPED: %s: could not get the option chain (%s: %s). The previous options file is kept.",
                  t["symbol"], type(e).__name__, e)
        return 1
    out = Path(args.out) if args.out else options_file(t)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(",", ":")))
    n = sum(len(e["calls"]) for e in payload["expiries"])
    log.info("Wrote %s (%d expiries, %d calls, %d bytes, as of %s)", out, len(payload["expiries"]), n,
             out.stat().st_size, payload["meta"]["as_of"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
