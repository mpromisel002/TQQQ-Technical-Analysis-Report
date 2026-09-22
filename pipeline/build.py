"""Build docs/data/tqqq.json for the dashboard.

Usage:
  python pipeline/build.py                     # live download
  python pipeline/build.py --csv-dir seed/     # offline, from TQQQ.csv / QQQ.csv
Exit codes: 0 = new data written, 3 = no new session (file unchanged), 1 = failure
(the previous good file is left in place).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import math
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch import NY, DataError, expected_last_session, fetch, sessions_behind  # noqa: E402
from indicators import compute_all  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "data" / "tqqq.json"
log = logging.getLogger("build")


def _clean(values, nd):
    return [None if (v is None or (isinstance(v, float) and math.isnan(v))) else round(float(v), nd)
            for v in values]


def build_payload(tq: pd.DataFrame, qq: pd.DataFrame, source: str, warnings: list[str]) -> dict:
    qq = qq.reindex(tq.index).ffill()
    ind = compute_all(tq)
    series = {
        "open": _clean(tq["open"], 4), "high": _clean(tq["high"], 4),
        "low": _clean(tq["low"], 4), "close": _clean(tq["close"], 4),
        "volume": [int(v) for v in tq["volume"]],
        "qqq_close": _clean(qq["close"], 4),
    }
    for col in ind.columns:
        series[col] = _clean(ind[col], 4)
    return {
        "meta": {
            "symbol": "TQQQ", "benchmark": "QQQ",
            "as_of": tq.index[-1].date().isoformat(),
            "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": source, "rows": len(tq), "warnings": warnings,
            "adjusted": "splits and dividends",
        },
        "dates": [d.date().isoformat() for d in tq.index],
        "series": series,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv-dir", help="read TQQQ.csv and QQQ.csv from this folder instead of downloading")
    ap.add_argument("--period", default="2y")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--force", action="store_true", help="write even if no new session")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    out = Path(a.out)
    try:
        csv = lambda s: str(Path(a.csv_dir) / f"{s}.csv") if a.csv_dir else None  # noqa: E731
        tq, src, warn = fetch("TQQQ", a.period, csv("TQQQ"))
        qq, _, warn_q = fetch("QQQ", a.period, csv("QQQ"))
    except DataError as e:
        log.error("%s", e)
        return 1
    if out.exists() and not a.force:
        prev = json.loads(out.read_text())
        if prev["meta"]["as_of"] >= tq.index[-1].date().isoformat():
            log.info("No new session since %s; nothing to do (holiday or weekend).", prev["meta"]["as_of"])
            return 3
    # the source can publish a session late; say so rather than quietly serving old data
    last = tq.index[-1].date()
    expected = expected_last_session()
    behind = sessions_behind(last, expected)
    if behind:
        msg = (f"data ends {last}, {behind} trading day(s) before the expected last close "
               f"{expected}")
        log.warning("%s", msg)
        warn = warn + [msg]

    payload = build_payload(tq, qq, src, warn + warn_q)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")))
    tmp.replace(out)
    log.info("Wrote %s (%d rows, as of %s)", out, len(tq), payload["meta"]["as_of"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
