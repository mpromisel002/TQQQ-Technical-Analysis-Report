# Plan: selling covered calls

Written 2026-10-31. Decisions made the same day (section 6). **Step 1, recording option chains nightly, is built** (`pipeline/options.py`). **Step 3, the card, is built ahead of step 2**, with temporary "thin" limits (section 7); step 2 replaces them once 2–3 weeks of chains are recorded.

**Goal.** For someone who owns the shares and wants to sell a call against them: suggest
strikes at the price levels the page already finds above the price, and say in plain words
what each one pays, how much rise it gives up, how likely it is to be called away, and how
little it protects against a fall.

> Educational use only — not investment advice. Selling a covered call caps the gain and
> keeps almost all of the loss. For a 3× leveraged fund that matters more than usual.

---

## 1. What was measured first (2026-10-31)

| Question | Answer |
|---|---|
| Can the page's price source give option chains? | Not to a browser: Yahoo's options address answers 401 ("Invalid Crumb") without a session cookie. The `yfinance` library the nightly job already uses handles that cookie and returns full chains. |
| What's in a chain? | Per strike: bid, ask, last price, volume, open interest, implied volatility, in the money or not. |
| Which tickers have chains? | TQQQ: 13 expirations (Nov 2, 2026 to Jan 19, 2029). QQQ: 25. SPY: 27. |
| Are the near strikes priced? | Yes, even on a Saturday (Friday's closing quotes). The $0.00 bids are the far strikes: 12 of 26 TQQQ strikes for Nov 2. |
| Are spreads usable? | Mostly. The Nov 6 $67 call is $1.01 bid, $1.20 ask. But the Nov 13 $71 call is $0.25 bid, $1.20 ask, a spread almost five times the bid. So a liquidity check is needed. |
| How often are there levels above the price? | Often few. Over the last 70 sessions TQQQ averaged 0.4 levels above the price with 3-day swings (1.3 with 2-day swings). On Oct 30, after a fall to $62.01, it had three. So the plan needs strikes for when there are none. |

### Worked example: TQQQ, Friday Oct 30, 2026 close $62.01

Levels above the price on the page: A1 $66.59, A2 $70.26, A3 $75.47. ATR (a typical day's
move) is $3.82. The nearest floor below is S1 $57.48. Each strike shown is the first one at
or above the level.

| Expires | At level | Strike | Bid / ask | Premium | Per year | Rise to strike | In typical days | Chance it ends above the strike | Breakeven | Return if called |
|---|---|---|---|---|---|---|---|---|---|---|
| Nov 6 (7 days) | A1 | $67 | $1.01 / $1.20 | 1.6% | 85% | +8.0% | 1.3 | 23% | $61.00 | +9.7% |
| Nov 6 | A2 | $70.5 | $0.27 / $0.77 | 0.4% | 23% | +13.7% | 2.2 | 12% | $61.74 | +14.1% |
| Nov 13 (14 days) | A1 | $67 | $1.50 / $1.88 | 2.4% | 63% | +8.0% | 1.3 | 27% | $60.51 | +10.5% |
| Nov 13 | A2 | $71 | $0.25 / $1.20 | 0.4% | 11% | +14.5% | 2.4 | 14% | $61.76 | +14.9% |
| Nov 20 (21 days) | A1 | $67 | $2.16 / $2.52 | 3.5% | 61% | +8.0% | 1.3 | 30% | $59.85 | +11.5% |
| Nov 20 | A2 | $70.5 | $1.25 / $1.58 | 2.0% | 35% | +13.7% | 2.2 | 20% | $60.76 | +15.7% |
| Nov 20 | A3 | $75.5 | $0.49 / $0.60 | 0.8% | 14% | +21.8% | 3.5 | 9% | $61.52 | +22.5% |

What it says in words, for the Nov 20 $67 call: *"Sell the Nov 20 $67 call for about $2.16
a share (3.5%). If TQQQ is above $67 on Nov 20, about a 30% chance by the option's own
price, the shares are sold at $67: an 11.5% gain including the premium, and nothing above
that. If it falls, the premium covers the first $2.16; the nearest floor, $57.48, is 7.3%
below Friday's close."*

---

## 2. What the page shows

A new card, **Selling covered calls**, after the support levels table. It is shown for
tickers on the daily list that have listed options; a ticker shown live (not on the list)
gets a note instead.

1. **One line of context first:** the last close, the date and time of the option prices, the
   nearest floor below, and the levels above the price.
2. **A table of suggested calls**, one expiry at a time (a switch picks it; the monthly is
   shown first), lowest strike first. The premium stands out: it is what the reader is paid.
3. **One sentence per row on demand** (tap a row): the plain-words reading in the example.
4. **A short warning that cannot be closed:** a covered call caps the gain at the strike and
   leaves the loss below the breakeven; for a leveraged fund a fall can be fast.

### How strikes are chosen

- **At each level above the price:** the first listed strike at or above A1, A2, A3, …
- **By chance of being called:** the strikes whose chance of ending above them is nearest 30%
  and 20%, using liquid calls when there are any. These are there every day, so they also cover
  the days with no level above the price (common: 0.4 levels a day on average for TQQQ). They
  replace the plan's first idea for those days, strikes at 1, 2 and 3 typical weekly moves.
- **Expiries:** the next 4 weekly ones and the nearest monthly within 45 days.
- **Strikes below the price are not suggested** (they are likely to be called away at once).

### How each figure is worked out

| Figure | How |
|---|---|
| Premium | The **bid**, not the last trade or the middle: what a seller is likely to get. As % of the last close. |
| Per year | Premium % × 365 / days to expiry. Shown with a note that short options repeated every week will not compound to this. |
| Rise to strike | Strike / last close − 1. Also in typical days of movement (÷ ATR), as the findings already do. |
| Chance it ends above the strike | From the option's implied volatility: N(d₂) with no interest rate. Worded as *"by the option's own price"*: it is the market's figure, not a forecast. |
| Breakeven | Last close − premium. Shown next to S1 and S2, so the reader sees how small the cushion is against a fall to the next floor. |
| Return if called | (Strike − last close + premium) / last close. |
| Liquidity | Open interest, and the bid-ask spread as % of the middle price. Rows below the thresholds are marked "thin", in their place by strike. |

---

## 3. Where the data comes from

**Nightly, with the price data.** The refresh job (`.github/workflows/refresh.yml`) already
runs at 16:17 New York. A new step, `pipeline/options.py`, fetches the calls for the chosen
expiries with `yfinance` and writes `<dir>/options.json` on the `market-data` branch,
next to the price file. Only the strikes the card can use are kept (from the close to +40%).
Measured on the Oct 30, 2026 close: 4 expiries each; TQQQ 149 calls (14 KB), QQQ 452 (44 KB),
SPY 351 (34 KB). Each night replaces the file, and every night's version stays in the
`market-data` branch's history: that history is the record step 2 reads.

- **Checks before publishing,** like the price data: bid ≤ ask, no negative prices, the
  underlying price in the file within 1% of the close the report has, the expiries in the
  future, at least one call with a bid. A failed check keeps the previous file; the prices are
  still published, and the run is marked failed so the failure is seen (and an issue opened).
- **Freshness on the card:** "Option prices from the Oct 30 close." If the file is older than
  the price data, the card says so instead of mixing days (the lesson from the after-hours
  line).
- **Live prices are not part of this plan.** A live `/options` request in the lookup service
  would have to handle Yahoo's cookie step itself, and option prices move fast. The
  end-of-day figures are for choosing strikes, not for placing an order.

---

## 4. Order of work

| Step | Pull request | What it holds |
|---|---|---|
| 1 | **Record option chains** | `pipeline/options.py` and the nightly step, the checks, tests. Nothing on the page yet. Run it for 2–3 weeks to collect real chains. |
| 2 | **Set the thresholds from the record** | Using the recorded chains: the normal spread and open interest for strikes near the money, so "thin" is set from measured values, not round numbers. Replay the rule against every recorded day and check it marks the cases above (e.g. $0.25 / $1.20) and not the normal ones. |
| 3 | **The Selling covered calls card** | Strike choice, the figures, the wording, the warning; in `docs/js/support.js` beside the levels, so the same code is tested in Node and in the browser. |

---

## 5. Tests

- **Saved real chains as fixtures** (`tests/fixtures/options-tqqq-2026-10-30.json`), so tests
  need no network. The worked example above becomes a test: the same strikes and figures.
- **Strike choice:** at each level above; the ATR fallback when there is none; nothing below
  the price; a level with no listed strike above it.
- **Figures:** the chance-above-strike formula against values worked out by hand; premium from
  the bid; per-year arithmetic.
- **Checks:** a broken chain (bid above ask, expired dates, wrong underlying price) is stopped
  with the reason, and the previous file is kept.
- **Browser, Chrome and Safari's engine:** the card's wording, a stale options file, a ticker
  with no options, phone width, nothing from the data file shown as HTML.

---

## 6. Decisions (made 2026-10-31: the suggestions were accepted)

| Question | Decided |
|---|---|
| Which expiries? | The last expiry of each of the next 4 weeks (daily Monday and Wednesday expiries skipped), and the nearest monthly within 45 days. |
| Strikes only at the levels, or also by chance of being called (e.g. about 20% and 30%)? | Both: levels first, then the two "by chance" strikes, so readers who sell by delta are covered. |
| Which tickers? | The daily list (TQQQ, QQQ, SPY): all have chains. |
| Show the yearly figure? | Yes, with the note that it is not a forecast. It is what sellers compare. |
| Include cash-secured puts (selling puts at the floors below)? | Not now. The same data and code would support it later, using S1, S2… as strikes. |

---

## 7. Step 3, built before step 2 (2026-10-31)

The card was asked for before the 2–3 weeks of records exist. So "thin" uses temporary limits,
set from the one night recorded (the Oct 30 close), in `SR.THIN` in `docs/js/support.js`:

| A call is thin when | Limit | What the Oct 30 record showed, strikes up to +25% |
|---|---|---|
| it has no bid | — | TQQQ 5 of 90 calls, SPY 55 of 339 |
| the gap between bid and ask is wider than this share of the middle price | 50% | TQQQ: middle strike 31%, one in four wider than 62%. QQQ and SPY: middle strike 9% |
| open interest is under | 100 | One strike in ten under 99–134 |

Replayed on the Oct 30 record: 34 of TQQQ's 90 calls up to +25% are marked thin. The case
named above, the Nov 13 $71 call at $0.25 / $1.20 (a gap of 131%), is marked; the Nov 6 $67 at
$1.01 / $1.20 (17%) is not. Step 2 replaces these limits with ones measured over 2–3 weeks.

The card is checked against the worked example in section 1: every figure in that table is a
unit test (`tests/support.test.js`), and the browser tests (`tests/browser/covered-calls.spec.js`)
use the same Oct 30 prices and option prices.
