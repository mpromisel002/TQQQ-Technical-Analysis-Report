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


# Tolerances for deciding the source has actually revised a session rather than
# merely disagreeing in the noise. Prices: 2 basis points, which catches a
# correction of a couple of cents on a $80 share while ignoring the sub-cent
# differences that appear when a run falls through to a different source.
# Volume: 2%, because consolidated volume keeps trickling in after the bell and
# a small restatement changes nothing about a support level.
PRICE_TOL = 2e-4
VOL_TOL = 0.02


def revised_fields(prev: dict, tq: pd.DataFrame, qq: pd.DataFrame,
                   price_tol: float = PRICE_TOL, vol_tol: float = VOL_TOL) -> list[str]:
    """Fields of the newest published session whose values the source has since moved.

    A session is published within minutes of the close, so the provider may still be
    settling it. Later runs call this to republish a corrected bar instead of exiting
    on the date alone. Only the most recent bar is checked: a dividend or split would
    move older values too, and rewriting history is not this function's job.
    """
    as_of = prev.get("meta", {}).get("as_of")
    dates = prev.get("dates") or []
    series = prev.get("series") or {}
    if not as_of or not dates or dates[-1] != as_of:
        return []
    ts = pd.Timestamp(as_of)
    if ts not in tq.index:
        return []

    moved = []

    def check(name, old, new, tol):
        if old is None or new is None:
            return
        old, new = float(old), float(new)
        if not (math.isfinite(old) and math.isfinite(new)):
            return
        if abs(new - old) > tol * max(abs(old), 1e-9):
            moved.append(f"{name} {round(old, 4)} -> {round(new, 4)}")

    for col in ("open", "high", "low", "close"):
        arr = series.get(col) or []
        if arr:
            check(col, arr[-1], tq.at[ts, col], price_tol)
    vol = series.get("volume") or []
    if vol:
        check("volume", vol[-1], tq.at[ts, "volume"], vol_tol)
    qc = series.get("qqq_close") or []
    if qc and ts in qq.index:
        check("qqq_close", qc[-1], qq.at[ts, "close"], price_tol)
    return moved


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
            # The schedule publishes minutes after the close, so the newest bar can
            # still be provisional. While it is the newest completed session, let a
            # later run replace it if the source has corrected it. Once the next
            # session closes the bar is left alone, which bounds this to one day.
            revising = prev["meta"]["as_of"] == expected_last_session().isoformat()
            revised = revised_fields(prev, tq, qq) if revising else []
            if not revised:
                log.info("No new session since %s; nothing to do (holiday or weekend).", prev["meta"]["as_of"])
                return 3
            log.info("Republishing %s: source revised %s", prev["meta"]["as_of"], "; ".join(revised))
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
