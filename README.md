# TQQQ Technical Analysis Report

A daily-updated dashboard of **TQQQ support and resistance levels**, found from 3-day swing lows and highs, with trend and momentum indicators. It runs on GitHub Pages and refreshes itself every weekday after the US market close.

**Live site:** `https://mpromisel002.github.io/TQQQ-Technical-Analysis-Report/`

## What's on the page

| Section | What it shows |
|---|---|
| Key findings | Up to five plain-language sentences: trend, nearest support and resistance, strongest level, momentum, typical daily move |
| KPI strip | Last close, trend label, nearest support and resistance, RSI, distance from 12-month high |
| Price chart | Candlesticks, 20/50/200-day averages, shaded support (green) and resistance (red) zones, swing markers, 3-day rolling low, volume-at-price, plus volume, RSI, MACD and drawdown panels on the same date axis |
| Levels table | Zone price and band, distance, touches, last test, strength score, status (Holding / Tested / Broken) |
| Window comparison | The top levels found with 1, 3, 6 and 12-month windows; levels found in 3 or more windows are ringed |
| TQQQ vs QQQ | Growth of $100, daily beta, returns and volatility |
| Technical indicators | Moving averages, RSI, MACD, Bollinger Bands, ATR, volume, each with a plain-language reading |
| What changed | New, broken and dropped levels, and trend or momentum changes since the previous session |

### Settings

- **Window**: 1M, 3M, 6M, 9M, 12M, or a custom number of trading sessions (21–252).
- **Method settings**: swing period (2–10 sessions, default 3), cluster distance (0.25–1.5 × ATR, default 0.5), minimum touches (1–5, default 1).

Settings are stored in the page address, so a view can be bookmarked or shared, for example
`?window=6m&period=3` or `?window=100&cluster=0.75`.

**Download CSV** saves the levels table and the daily data for the window. **Download PNG** saves the chart.

## Method

1. **Swing low**: a day whose low is the lowest from 3 sessions before to 3 sessions after. The last 3 sessions are shown as *pending* (hollow markers) until confirmed.
2. **Rolling low**: the lowest low of the last 3 sessions, drawn as a step line.
3. **Zones**: swing lows within 0.5 × ATR(14) of each other are merged. Zone price = volume-weighted average of its lows; band = lowest to highest low.
4. **Strength (0–100)**: touches 40%, recency 30%, volume at the touches 20%, bounce over the next 10 sessions 10%. Scores are relative within the selected window.
5. **Resistance**: the same steps on the highs.
6. **Broken levels**: when price closes through a zone by more than half the cluster distance, the zone switches role (support ↔ resistance) and is drawn dashed.
7. **Trend call**: price vs. the 50 and 200-day averages, the 50-day slope over 20 sessions, and whether the last two swing lows are rising. All three agree gives Uptrend or Downtrend; otherwise Mixed.
8. **Thin windows**: when fewer than 2 supports are found, the 3-day rolling low and the 50-day average are shown as fallback levels.

The support calculation runs in the browser (`docs/js/support.js`), so changing the window is instant. The same file runs in Node for the daily snapshots and the unit tests, so there is only one copy of the method.

## How it works

```
GitHub Actions (weekdays 22:30 UTC)
  → pipeline/build.py    download TQQQ + QQQ (yfinance → Yahoo chart API → Tiingo → Alpha Vantage),
                         validate, compute indicators, write docs/data/tqqq.json
  → pipeline/snapshot.js save today's levels to docs/data/history/, write docs/data/changes.json
  → commit to main → GitHub Pages serves /docs
```

- Prices are adjusted for splits and dividends. About 2 years are loaded so the 200-day average is ready for the full 12-month view.
- Before publishing, each run checks for missing values, zero volume, bad high/low values, gaps in the dates and one-day moves over 40% (a sign of a bad split adjustment). If a check fails, nothing is published and the previous good file stays live.
- If a run fails, the workflow opens a GitHub issue (or comments on the open one). The page shows the data date in red if it is more than 2 sessions old.
- On weekends and market holidays the job finds no new session and exits without committing.
- GitHub pauses scheduled workflows after 60 days without repository activity; the daily data commits keep it active.

## Repository layout

| Path | Purpose |
|---|---|
| `.github/workflows/refresh.yml` | Daily schedule, manual trigger, tests, data build, commit, failure issue |
| `.github/workflows/tests.yml` | Tests on code pushes and pull requests |
| `pipeline/fetch.py` | Downloads and validates prices, with backup sources |
| `pipeline/indicators.py` | Moving averages, RSI, MACD, Bollinger Bands, ATR, drawdown |
| `pipeline/build.py` | Builds `docs/data/tqqq.json` |
| `pipeline/snapshot.js` | Daily level snapshots and "what changed" |
| `pipeline/tests/` | pytest checks on saved price data |
| `tests/support.test.js` | Node unit tests for the support/resistance method |
| `docs/index.html`, `docs/css/`, `docs/js/` | The page: `support.js` (method), `charts.js` (canvas charts), `app.js` (page logic) |
| `docs/data/tqqq.json` | Latest data, rewritten each run |
| `docs/data/history/` | Dated snapshots of the levels table |

The charts are drawn with a small built-in canvas library, so the page has no external dependencies and loads fast.

## Setup

1. **Enable GitHub Pages**: Settings → Pages → *Deploy from a branch* → `main` / `/docs`.
2. **Allow the workflow to push**: Settings → Actions → General → Workflow permissions → *Read and write permissions*.
3. *(Optional)* **Backup data sources**: add `TIINGO_API_KEY` and/or `ALPHAVANTAGE_API_KEY` under Settings → Secrets and variables → Actions. Both offer free keys.
4. Run **Actions → Refresh TQQQ data → Run workflow** once to check that everything works.

GitHub Pages is free for public repositories; private repositories need a paid plan.

## Run locally

```bash
pip install -r pipeline/requirements.txt
python pipeline/build.py --force        # download and build data
node pipeline/snapshot.js               # levels snapshot + what changed
python -m pytest -q pipeline/tests      # Python tests
node --test tests/*.test.js                      # JavaScript tests
python -m http.server -d docs 8000      # open http://localhost:8000
```

Offline build from CSV files (`date,open,high,low,close,adjclose,volume`): `python pipeline/build.py --csv-dir path/to/folder --force`.
Rebuild the history for the last 30 sessions: `node pipeline/snapshot.js --backfill 30`.

## Disclaimer

For educational use only. This is not investment advice. TQQQ is a 3× leveraged ETF that resets daily; it can lose value quickly, and over periods longer than one day its return can differ greatly from 3× the Nasdaq-100. Support and resistance levels describe past trading and do not predict future prices. Data may be delayed or contain errors.
