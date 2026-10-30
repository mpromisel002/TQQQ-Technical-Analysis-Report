# Change plan — support levels above price, any ticker, chart navigation, indicators

Written 2026-10-25. This file records what was asked for, what the review found, and the plan agreed. It is meant to be shared with the original owner of the app. The [README change log](../README.md#change-log) records each phase as it lands.

**Status:** test automation, the security checks, phase 3 (chart scrolling), phase 1 (levels above price), remembered settings with readable dates, phase 4 (Bollinger Bands), levels from at least 200 sessions, the every-combination tests, and phase 5 (show or hide every layer) are done. Phase 2 is done in code: several tickers from a list, and any ticker live with adding to the list. The lookup service still has to be deployed by the owner.

**Pull requests, each built on the one before:**

| Order | Branch | What it holds |
|---|---|---|
| 1 | `test-automation` | Tests only. No change to what the app does |
| 2 | `security-checks` | Vulnerability checks and one escaping fix (section 10) |
| 3 | `chart-scroll-and-levels-above-price` | Phases 3 and 1 |
| 4 | `usability-memory-and-dates` | Remembered settings and readable chart dates (section 11) |
| 5 | `bollinger-bands` | Phase 4, Bollinger Bands (section 7) |
| 6 | `levels-min-200-sessions` | Every level from at least the last 200 sessions; the chart fits every time frame (section 12) |
| 7 | `test-every-combination` | Tests only: the chart checked in every combination of options (section 13) |
| 8 | `show-hide-indicators` | Phase 5: show or hide every chart layer, with its tests (section 8) |
| 9 | `multi-ticker` | Phase 2, part 1: several tickers from a list (section 5) |
| 10 | `any-ticker` | Phase 2, part 2: any ticker, live, and adding it to the daily list (section 5) |
| 11 | `page-order` | Order of the page; "What changed" in the bottom line (section 14) |
| 12 | `test-safari` | Browser tests in Safari's engine, and two Safari fixes (section 15) |
| 13 | `data-branch` | The daily data on its own branch (section 16) |
| 14 | `readme-screenshot` | README: a screenshot at the top, and brought up to date |
| 15 | `extended-hours` | Pre-market and after-hours price (section 18) |

---

## 1. What was asked for

The requests, copied word for word:

> do a review of this application and create a plan to modify it to show a)all support levels even if they are above the current levels, currnetly it only shows support for current price and below, it removes higher support levels b) a second phase to let me request different tickers not just TQQQ

> c) phase 3 to make the navigation of chart more standard, now hwne scrollign the page with finger press on mause pad the chart starts zooming d) add bollinger bands e) give abilitty to hid show indictors to make ti easier to read

> Above-price levels on the chart do as recommended / Phase 2 - option b, default list TQQQ, QQQ, SPY if a user asks for a ticker it should be validate and if valid add to default list so it is maintained

> keep alog of my prompt and this plan in a file id docs so it can be shared with the original owner of the the app, in readme add a change log

> oh ok, do 3 and one on this branch that will be the first PR for the owner

> do a review of the application do we have good test coverage automation, do we have any gaps we need to close before we submit a PR with these 2 changes

> i want to make a branch with any required test automation improvmements that will be PR#1 to the app owner, then make all our functional changes a second PR ontop of PR#1 leveraing all the ststs

> does each branch contain a file with the prompt and plan adn update hte change log inreadme?

> is branch 2 ontop of branch 1

> fix reset view on branch 2 / on branch one do we have any vunerabilties are check vunerabilties part of test automation?

> on merge do we have github configured to run tests

> lets make vunerabilty fixes a PR on top of branch 1 keep it seperate so review is not overwhelmeed

> include prompt and plan for vunerabilties on it and any test enh for vunerabilties

> se we will have branch 1 for tests, branch 2 for vunerabilties , branch 3 for functional changes

> prs shoudl be rebased on each other in order

> how do we test branch 3 before we submit PR?

> yes / i tried to test but link is not working

> after pr created alwasy remind me to disable daily updates remmeber that!

> change default on branch 3 to 1m from 12m

> did we squash on all 3 branches so pr are clean?

> remember to always do that for PRs

> track pad works great lets send PR if all tests passed in order, make it clear in each pr them must be reviewed and merge din order as they build on each other

> lets create PR4 to address some usablity / does it remember locally my choices for light-dark, remeber the ptions I set like # months, which metrics to show (ie remmeber what I did in last use/session and not reset to defaults / look at main graph dates are hard to see/read what do you sugget ot improve the UX for the dates see screenshot

> is there any changes on the owners main that requires us to rebase PRs?

> send it

> close the draft PRs in my fork

> is update disabled on my fork main?

> let's start phase 4 bollinger bands as PR5

> have we covered all changes with tests ?

> ij di recommenation

> looking at sight when we added support levels above we seemed ot have lost all the support levels below!

> we should have a test that we keep all known support levels above and below

> for last 200 days

> make bollinger on by default unless a user changes

> whats in PR5

> pr5 we should be seeing all support levels valid the last 200days but we are not

> we should see min 200, more if bigger time window

> chart looks odd / we shoudl show one level below current floore band

> do you think thats right to do?

> yes do it

> test shoudl check rendering for all timer periods thinks look bad on 12m for instance

> 1m has alot of white space

> make sure tests cover all UI opionts and combinations

> of time frames

> lets make adding this automation of all compbinations a seperate PR

> in current functional PR we have alot of whitespace margins can we sue more of the screen, is there a reason for the big margins that we would want to keep them

> lets not combine functioanl changes with the test PRS

> ok

> send PRs 5, 6 and 7

> margins are very tight now can we double the width on PR7?

> let me review irst

> formatting is off on this text

> make margins 50% wider

> go push PRs 6 and 7

> does all CI pass with the recent changes?

> whats next

> yes, include any changes to tests as part of this change

> how long does a full combo run take

> eta?

> support below price removes the current support it should not either show the support level we are in or the one closestst above and below even when unchecked

> status ?

> send PR 8

> anyone

> yes start PR 9

> the time tiles moved they should be near the graph

> 3 month view not correct showing one lower support just current support and higher

> never mind my review was wrong its oK

> send PR 9

> explain pr 10?

> fold it into PR 11

> yes start PR 10

> the UX is not intuitve to set the ticker

> push it

> reivew the UI, what changes would you make to the order of the content

> lets do 1-3

> what do you think about moving "What changed since the previous session" up?

> yes do both in PR 11

> text wrapping not using whitespace on the right

> send PR 11

> yes update the titles to /11

> yes update those too

> whats next

> what do you think about combining the PR's but will it be clear for mpromisel to review? or be too big

> are there any gaps in testing now?

> start PR 12 - lets add safari #1

(Asked how to split the fixes from the Safari tests, the answer was: one pull request, the fixes with Safari added to the test runs as their tests.)

> finish the safari work first so we can do the PR

> did we submit 12?

> yes renumber them to /12

> I see the data refreshes are on the main branch what approach can we take to not commit them there?

> what approach do we use for Ihaveannuities that we run on github

> yes start PR 13 that way

> thinking about it is it the same repo or a new repo so it doesnt bloat this one

> ok

> review readme any recommendations to update it?  can we add a good screen shot at the begging of it?

> make it PR 14 and send it

> do we have an option to after hours price on top and projected open?

> Yes

> problem isclose is not todays close

> yes fix the banner in PR 15

## 2. Decisions made

| Question | Decision |
|---|---|
| Levels above price: shown by default? | **Yes**, in a muted colour, with a switch to hide them |
| Other tickers: fixed list, or any ticker? | **Any ticker.** A requested ticker is checked; if it passes, it is added to the daily list and kept up to date from then on |
| Starting list | TQQQ, QQQ, SPY |
| Who may add tickers, and how many | **Anyone**, at most 50 tickers on the list and at most 5 additions per visitor per day (decided 2026-10-25) |

## 3. How the app works today

| Part | What it does |
|---|---|
| `pipeline/fetch.py`, `pipeline/build.py` | Download TQQQ and QQQ daily prices (Yahoo, with Tiingo and Alpha Vantage as backups), check them, write `docs/data/tqqq.json` |
| `docs/js/support.js` | The support method. The page and the nightly snapshot job (`pipeline/snapshot.js`) use this one file |
| `docs/js/app.js`, `docs/js/charts.js` | Draw the report and the charts. The site is static GitHub Pages with no server |
| `.github/workflows/refresh.yml` | Runs every weekday evening after the US close and commits new data |

---

## 4. Phase 1 — show support levels above the current price

**What the review found.** `docs/js/support.js:165` marks a zone as "broken" when the close is below it:

```js
z.broken = price < z.low - half;
```

Every zone above today's price therefore counts as broken, and `support.js:175` keeps only zones that are not broken. The levels above price only show up as one line at the foot of the table and in the "what changed" feed.

Measured on the data as of 2026-10-23 (close $66.29):

| Window | Levels shown | Levels hidden above the price |
|---|---|---|
| 1 month | **none** | $67.43 (score 97), $75.47 (score 83) |
| 3 months | 2 | $75.47 |
| 6 months | 2 | $70.26 (3 touches, score 70, Strong) |
| 12 months | 5 | $70.26 (3 touches), $75.47 |

The 1-month view says no support was found, even though two well-scored levels sit just above the price.

**Plan.**

| Step | Change | Where |
|---|---|---|
| 1 | Split zones into **at or below price** (S1–S5, unchanged) and **above price**, returned as their own list, nearest first, limit 5 | `support.js:164–180` |
| 2 | Own labels for levels above price (A1, A2, …) with the status "Above price — was support, price closed below it". They do not take places from S1–S5 | `support.js` |
| 3 | Show them in the levels table above the "Last close" row, so the table reads in price order | `app.js:228–252` |
| 4 | Draw them on the chart in a muted colour, shown by default, with a legend entry and a switch | `app.js:413`, legend |
| 5 | Add "Nearest level above price: $X, Y% above" to the findings and the bottom line. Stop the 1-month view saying no levels exist when some sit above the price | `findings()`, `bottomLine()` |
| 6 | Save every level above price in the daily snapshot, not just the first 5 | `snapshot()` at `support.js:537` |
| 7 | Add them to the CSV export. Update the README glossary and the Method panel in `index.html:169,181` | |
| 8 | Tests: a zone above price is listed, not dropped. S1–S5 match today's output on every saved history file | `tests/support.test.js` |

---

## 5. Phase 2 — any ticker, added to the daily list once it passes the checks

**What the review found.** "TQQQ", "QQQ" and the 3× leverage are hard-coded in about 40 places: the data file name, the fetch calls, page titles, the benchmark panel, the "daily resetting cost" finding and the disclaimer. A browser can't download prices from Yahoo directly, because Yahoo blocks requests coming from other websites, so viewing a new ticker live needs a small proxy service.

**How it will work.**

1. The visitor types a ticker.
2. If it is on the daily list, the page loads its saved data: the full report, with history and what-changed.
3. If it is not, the page asks the proxy. The proxy checks that the ticker exists and has at least 260 trading days of data, sends the prices back so the report shows right away, and asks GitHub to start an **add-ticker** job.
4. The add-ticker job runs the same checks as the nightly refresh (`fetch.py validate()`). If the ticker passes, the job adds it to `tickers.json`, builds its data and commits. The nightly refresh keeps it up to date from then on.
5. If it fails, the page says why in plain words ("only 140 trading days of history; 260 needed") and nothing is added.

**Plan.**

| Step | Change |
|---|---|
| 1 | `pipeline/tickers.json`: TQQQ (benchmark QQQ, 3×), QQQ (benchmark SPY, 1×), SPY (no benchmark, 1×). New tickers default to 1× against SPY |
| 2 | `build.py --symbol X` writes `docs/data/<sym>/`. Move TQQQ's existing files there so its history is kept. The nightly job loops over the list, and one failed ticker does not stop the others |
| 3 | Copy the indicator maths (`indicators.py`) into JS so the page can work out indicators for a live ticker. A test checks the JS numbers match the Python ones on every series in the saved data |
| 4 | Proxy: a free-tier Cloudflare Worker in a new `proxy/` folder, with `GET /prices?symbol=` and `POST /add?symbol=` |
| 5 | New `.github/workflows/add-ticker.yml`, started by the proxy: checks again, adds to the list, builds, commits |
| 6 | Page: a ticker box with a dropdown of listed tickers, `?ticker=` in the page address, and all ticker, benchmark and leverage wording taken from the ticker's settings. Leverage text only for leveraged funds |

**Limits, because the site is public** (see the open question in section 2):
- Tickers must be 1–10 characters (letters, digits, `.`, `-`, `^`), and only stocks and ETFs are accepted.
- At most 50 tickers on the list. Once it is full, a new ticker can still be viewed live but is not added.
- At most 5 additions per visitor per day.
- A listed ticker that fails 5 nightly runs in a row opens an issue rather than being retried for ever.
- Not measured yet: how long the nightly run takes with 50 tickers, and whether Yahoo slows down repeated downloads. This will be timed with a real list before the limit is raised.

**Setup the owner will need to do** (about 10 minutes; step-by-step notes will come with the code):
- A free Cloudflare account, and one `npx wrangler deploy`.
- A GitHub fine-grained token for this repository only, with **Actions: write** and nothing else, saved as a secret in the Worker.

---

**Split into three pull requests**, each on the one before:

| PR | What | Status |
|---|---|---|
| 9 | Several tickers from `docs/data/tickers.json` (TQQQ, QQQ, SPY): a menu and `?ticker=` links, per-ticker data folders, wording from each ticker's entry, the nightly refresh building every ticker | Done |
| 10 | Request any ticker, with the indicator maths in JavaScript folded in (asked for: one pull request with a visible feature rather than one with none): a Cloudflare Worker fetches it and starts an "add ticker" job, within the limits above | Done; switching it on needs the owner's Cloudflare account and a GitHub token (`proxy/README.md`) |

**Decisions made while building PR 9.**
- TQQQ's files stay at `docs/data/` (no move, so its history and anything linking to `docs/data/tqqq.json` are untouched); other tickers get `docs/data/<symbol>/`.
- SPY's benchmark is QQQ rather than none: it compares the S&P 500 with the Nasdaq-100 and avoids a special "no benchmark" case throughout the page.
- The benchmark series is now `bench_close`; files written before the change (`qqq_close`) are still read.
**Building PR 10, what was measured and decided.**
- The JavaScript indicators first seemed to differ from Python's (RSI by up to 0.0002). The cause was measured, not guessed: the data files store prices rounded to 4 decimals, while Python worked from unrounded prices. Run on the same prices, the two agree to 1.7e-10 on every day of every series. The test compares them on the same prices, against a reference file that a Python test keeps up to date.
- A ticker added from the page gets plain (unleveraged) wording and no index, since neither is known; an owner can edit its entry.
- The add job builds the data file before adding the entry, so the list never names a ticker whose data is missing; if building fails, the list is unchanged.
- The lookup service leaves out today's bar until 16:15 New York time, like the nightly refresh.
- Choosing a ticker was not obvious: a menu hidden in the title for listed tickers, and a separate box elsewhere for any other. Replaced by one labelled **Ticker** field at the left of the top bar. It suggests the listed tickers with their names (it empties on click so all of them show) and takes any symbol. A picked suggestion opens straight away; typed letters wait for Enter, so typing "QQQM" does not stop at "QQQ".

- The time buttons (1M–12M) had always been in the bar at the top of the page. Since levels now come from at least 200 sessions, they mainly set how much of the chart is shown, so they moved into a toolbar directly above the chart, with Daily/Mondays and the zoom buttons (asked for while reviewing this pull request).

## 6. Phase 3 — standard chart navigation

**What the review found.** `app.js:375` sets `wheelZoom: true` on the main chart, so the handler at `charts.js:322–331` turns every scroll event over the chart into a zoom and stops the page scrolling. Two-finger scrolling on a trackpad sends the same scroll events, so moving down the page zooms the chart whenever the pointer passes over it.

**Plan**, matching how TradingView and embedded Google Maps behave:

| Gesture | Today | After |
|---|---|---|
| Two-finger scroll up/down, mouse wheel | Zooms the chart | **Scrolls the page** |
| Two-finger swipe left/right | Ignored | **Moves the chart through time** |
| Trackpad pinch | Zooms | Zooms. The Mac browser sends a pinch as a scroll with Ctrl held, which the existing check already handles |
| Ctrl/⌘ + scroll | Zooms | Zooms |
| Drag, double-click, + / − / 0 keys, phone pinch | Work | Unchanged |
| Buttons | Reset view | Add **+** and **−** |

Steps: remove `wheelZoom: true`; add a sideways-swipe handler that pans the chart; show a 2-second hint on the first plain scroll ("Pinch or hold ⌘ and scroll to zoom"); update the help text in `index.html:104` and `README.md:129`. Checked by hand in Chrome and Safari with a trackpad, because the unit tests do not cover gestures.

---

## 7. Phase 4 — Bollinger Bands

**What the review found.** The bands are already worked out (`indicators.py:77`) and saved in `tqqq.json`, but they only feed the written findings and the indicator table. Nothing draws them.

**Plan.** Draw the upper and lower bands on the price chart as thin lines with a light fill between them. Draw the middle band only if it differs from the 20-day average line, which will be checked against the data first. Add the band values to the hover tooltip and a legend entry. Off by default, with a switch.

**Done (fifth pull request).** The middle band was checked against the 20-day average: identical in all 482 sessions, so it is not drawn twice. The bands are drawn in the 20-day average's blue, dashed, with a light fill; the price scale stretches to fit them when they are on, so they are never cut off. On by default, as asked; switching them off is remembered, and readers whose saved switches predate the bands get them on. Four browser tests; they fail on the previous code.

---

## 8. Phase 5 — show or hide every indicator

**What the review found.** Volume, RSI, MACD, % below 12-month high, the 3-day low and Volume by price can already be switched on and off (`index.html:96–101`). The 20, 50 and 200-day averages, the support zones and the swing-low markers are always drawn.

**Plan.**
1. Two rows of switches. **On the price chart:** 20 / 50 / 200-day averages, Bollinger Bands, support below price, levels above price, swing-low markers, 3-day low, Volume by price. **Panels below:** Volume, RSI, MACD, % below 12-month high.
2. A **Simple view** button (candles, support zones, 50 and 200-day averages only) and a **Show all** button.
3. Choices are kept between visits, as they already are, and saved in the page address so a shared link opens with the same view.
4. The legend lists only the layers that are switched on.

**Done (eighth pull request), with the test changes in the same pull request, as asked.**

| Item | Done |
|---|---|
| New switches | More support below the price, 20-day, 50-day and 200-day averages, swing lows — 13 switches in all, on by default as before. The nearest level below or at the price (S1) and the nearest above (A1) always stay on the chart; "More support below" and "More levels above" add the rest, so unticking them never hides the level the price is in |
| Two labelled rows | "On the price chart" (9) and "Panels below" (4) |
| Simple view / Show all | Simple view: candles, support below the price, 50 and 200-day averages. Show all: everything |
| Legend | Lists only what is shown |
| Page address | `?show=…` when the layers differ from the defaults; a shared link wins over a reader's saved layers |
| Every-combination tests | Per pull request: 28 settings (all off, all on, each alone, each off alone). Weekly: every combination of the 7 switches that change where things are drawn (four panels, Bollinger Bands, the two kinds of level), each with the other 6 all on and all off — 256 settings. All 8,192 combinations of 13 switches would take about 4 hours |

---

## 9. Test automation (done first, as its own pull request)

The review of the tests found that the page code had no tests at all, and both changes above are mostly page code. That pull request comes first, so the changes can be checked against it. It adds no features.

| Gap found | Closed by |
|---|---|
| `app.js` and `charts.js` (about 1,300 lines) had no tests | Browser tests that open the real page in Chrome, desktop and phone sizes |
| Nothing showed whether a change moved a support level | `tests/golden.test.js`: every level and "what changed" item for 241 sessions, compared with a recorded copy |
| Seven tests read the live data file, which changes daily, and passed without checking anything if it was missing | They read a frozen copy in `tests/fixtures/` |
| `pipeline/snapshot.js` (the nightly job) had no tests | `tests/snapshot.test.js` runs it on a temporary folder |
| `fetch.py` was 66% covered; choosing between data sources was untested | `pipeline/tests/test_sources.py`, no network needed; now 85% |
| Coverage was never measured | Shown per file on each CI run's summary page |

Found while doing this, not changed:
- **Reset view does not return to the opening view.** The chart opens on the chosen window, but Reset view, double-click and the 0 key show all two years of history. A browser test records this as the current behaviour. *Fixed in the third pull request: they now return to the window the chart opened on.*
- `fetch.py:95` uses `datetime.utcfromtimestamp()`, which Python has marked for removal.

## 10. Security checks (its own pull request, after the tests)

**What was checked on 2026-10-25, and what was found.**

| Check | Result |
|---|---|
| Python packages (`pip-audit`, the versions the daily refresh installs today: pandas 3.1.0, numpy 2.5.4, yfinance 1.7.0, requests 2.34.2 and their dependencies) | No known vulnerabilities |
| npm packages (`npm audit`; only the Playwright test tool, 3 packages) | No known vulnerabilities. All 3 have verified registry signatures |
| Text from the data files reaching the page | **One gap.** In "What changed", an item's type was put on the page as HTML, not text. A browser test showed it could add an element to the page. Fixed: it is now escaped like the item's text. The data comes from this repository's own nightly job, so this was not reachable from outside today; it matters for the planned any-ticker feature |
| Node.js version in CI | **Out of date.** The workflows used Node 20, which stopped receiving security fixes on 2026-04-30. Moved to Node 24; all tests pass on it |
| Was anything checking for vulnerabilities? | **No.** No audit step and no Dependabot |
| Do tests run on a pull request and after a merge? | Yes (`tests.yml`). **But nothing stops a merge when they fail**: `main` has no branch protection in the owner's repository |
| GitHub Actions versions | `checkout@v4`, `setup-python@v5`, `setup-node@v4`, `upload-artifact@v4` are each three major versions behind. No known vulnerability; left for Dependabot to propose one at a time |
| Python package versions | `requirements.txt` sets minimum versions only, so each run installs whatever is newest. Not changed here; the weekly audit checks those versions |

**What this pull request adds.**

| Change | Why |
|---|---|
| `.github/workflows/security.yml`: `pip-audit` and `npm audit` on every pull request, after each merge, and every Monday | A new advisory can appear for a package that has not changed, so a weekly run catches it |
| A step that runs the audit on `requests` 2.19.0, which has known vulnerabilities, and stops the run if the audit reports nothing | So a broken audit step cannot pass without anyone noticing |
| `npm audit signatures` | Checks the test tool's packages were signed by the npm registry |
| `.github/dependabot.yml`: weekly update pull requests for the Python packages, the npm test tool and the GitHub Actions | Keeps versions current without anyone having to remember |
| `tests/browser/security.spec.js`: puts HTML and script in every text field of the data files and checks none of it reaches the page as HTML | Covers the gap above, and every other place data text is shown |
| The escaping fix in `docs/js/app.js` (`renderChanges`) | The gap above |
| Node 24 in all three workflows; the test workflow's token limited to reading the repository | Node 20 gets no more security fixes; the tests need no write access |

**Settings the owner has to change** (a pull request cannot change these):
1. **Require the tests to pass before merging:** Settings → Branches → Add rule for `main` → *Require status checks to pass*, and pick "Python and JavaScript unit tests", "Browser tests (the page itself)", "Python packages" and "npm packages (test tooling)".
2. **Turn on vulnerability alerts:** Settings → Code security → *Dependabot alerts*. The config file only drives the weekly update pull requests, not the alerts.

## 11. Remembered settings and readable dates (fourth pull request)

**What was measured.** Every setting was changed, then the page was reopened from its plain address, as from a bookmark:

| Setting | Remembered before | After |
|---|---|---|
| Light/dark theme | Yes | Yes |
| Panels and overlays shown | Yes | Yes |
| Daily / Mondays | Yes | Yes |
| Window (number of months) | **No** — back to 1M | Yes |
| Method settings (swing period, cluster distance, minimum touches) | **No** — back to the defaults | Yes |

The window and method settings lived only in the page address. They are now also kept in the browser. A link that carries settings still wins, so shared links open as sent.

**Why the dates were hard to read.** The date strip's position assumed a 14-pixel gap under the last panel, but the last panel has no gap, so the dates were drawn inside the volume panel, on top of its bars. They were also small, faint grey, and written "09-25".

| Before | After |
|---|---|
| Drawn over the volume bars | Their own strip under the last panel, with a small tick at each date |
| "09-25" | "Sep 25"; the first trading day of a month in bold ("Oct"); January with its year ("Jan 2026") |
| Faint grey, 11px | Darker, 12px |
| Hover tag "2026-10-16" | "Fri, Oct 16, 2026", kept on the chart near the edges |

## 12. Every level from at least the last 200 sessions (sixth pull request)

**What was asked.** Show every support level found in at least the last 200 sessions, and more when the chosen window is longer.

**What the page did.** It found levels only within the chosen window — 21 sessions for 1 month, which on 2026-10-23 had nothing below the price — and listed at most five on each side.

**What it does now.**

| | Before | After |
|---|---|---|
| How far back levels are found | The window (1M = 21 sessions) | At least 200 sessions, or the window if longer (12M = 252) |
| How many are listed | Strongest 5 on each side | Every level found |
| 1M on 2026-10-23 | Nothing below the price; A1, A2 above | S1–S6 below ($66.72 to $37.16); A1, A2 above |
| What the window still sets | — | How much of the chart opens; the period for returns and volatility |
| Levels outside the chart's view | Tags pushed into view beside the wrong price | One edge tag naming the nearest: "▼ S3 $50.18 · 3 more below" |
| The next floor below the current one | Off the chart on 1M | Always on the chart, unless reaching it would stretch the price scale by more than half; then the edge tag names it |

Unchanged: the 1/3/6/12-month comparison panel (it compares those exact lengths), and the daily snapshot and "What changed" (12 months, strongest five each side), so the recorded-output test is identical.

**The next floor below.** Asked for after seeing the chart. Measured on 2026-10-23: bringing S2 ($57.48) into the 1-month view grows the price scale by 35%; for 3 months by 3%; for 6–12 months not at all. A limit of 50% keeps a far-off floor from squashing the candles; past it, the edge tag names the floor instead.

**Chart fixes found by checking every time frame** (all in this pull request; the tests that check every combination are the next one):

| Problem | Cause | Fix |
|---|---|---|
| At 12 months the price tags hid the newest candles | Space after the newest bar was 4 bars: about 15 px at 12 months, less than one tag | Space is the width of the widest tag, in pixels |
| At 1 month a wide empty gap after the newest candle | The same 4 bars: about 320 px at 1 month (132 px measured beyond what the tags need) | As above |
| With close-together levels, tags (including the last price) pushed up to 48 px from their line | Tags were nudged apart in one direction only, and a stack that ran off the panel slid back, price tag included | The last-price tag never moves; others move away from it with a short line back to their level; tags that do not fit are folded into the edge tag, which moves to the left corner when the price tag is in its way |
| On a phone, Mondays view, the first date label cut off at the left edge | No check for the chart's edge | Labels that would be cut off are left out |
| Large empty margins on wide screens | The page stopped at 1180 px wide | 1600 px; text blocks keep their own line-length limits (72–92 characters), so reading is unchanged. The margin each side is 48 px on a desktop (it was 16, which felt tight at the new width) and stays 16 px on a phone. The help under the chart was one long paragraph on seven topics; it is now six short labelled items, 3 columns on a desktop, 2 mid-size, 1 on a phone |

**Found while doing this.** When a level was above or below the visible part of the chart, its tag was pushed into view and sat beside the wrong price (for example "S2 $57.48" next to $85). This was also true of the owner's code when zoomed in. Fixed: such levels get one tag at that edge.

## 13. Tests for every chart combination (seventh pull request, tests only)

**What was asked.** Tests should check the chart's drawing at every time frame, and cover every option and combination. Kept as its own pull request, with no change to the app.

**How many combinations.** 8 chart switches (256 settings) × 5 time frames × Daily/Mondays × light/dark × desktop/phone = 10,240 drawings. Measured: about 90 ms each including the checks, 7.2 minutes on an 8-core Mac. Too slow for every pull request, so:

| When | What is drawn | Time measured |
|---|---|---|
| Every pull request | Every time frame × Daily/Mondays × light/dark × 18 switch settings (all off, all on, each alone, each off alone); custom lengths 21–252; method settings at their limits; clicking each switch at each time frame | about 40 s on an 8-core Mac |
| Every Monday and on demand | The same, with all 256 switch settings | 7.2 min on an 8-core Mac |

**What each drawing is checked for:** no tag over another tag or a candle; the last-price tag exactly on its price; a tag moved off its line joined back to it; every level tagged or counted in an edge tag; date labels not colliding or cut off; no candle cut off at the top or bottom; panels and legend matching the switches; no errors. A self-check removes the room kept for tags and confirms the checker reports the hidden candles.

**What it found.** Run against the earlier code, it found the problems fixed in the sixth pull request: tags pushed off their lines (up to 48 px, the price tag included), the edge tag landing on the price tag, and a date label cut off on a phone. Against the sixth pull request: all 10,240 drawings pass.

## 14. Order of the page (eleventh pull request)

**What was asked.** Review the order of the page's content, then make the first three changes proposed. Then fold "What changed" into the bottom line, and check why its note said "12-month window" when the page opens at 1M.

**Measured before and after** (desktop window 1400 × 900; phone 390 × 844):

| Section | Desktop: pixels from the top, before → after | Phone: before → after |
|---|---|---|
| Key numbers | 714 → 152 | 1186 → 298 |
| Bottom line | 136 → 287 | 282 → 639 |
| What changed since the previous session | 3780 → 782 | 6291 → 1465 |
| The chart itself | 1158 → 1047 | 2304 → 1838 |

**The three changes.**

1. **The chart sits directly under its toolbar.** The description, legend and switches moved below the chart, above the help items. On a desktop this was 310 pixels of text above the chart, on a phone 777.
2. **"What changed since the previous session" moved up** from the bottom of the page into the bottom line, as its last row, **Since the previous session**. It is the day's news, and on most days it is one line ("No changes…"), which did not need a card of its own above the chart.
3. **The key numbers come first**, above the bottom line: six figures read at a glance.

The bottom line still comes before the chart, as the owner designed it ("the answer before the evidence"). Moving the chart above the bottom line was offered and not chosen. Everything from the levels table down is unchanged.

**"What changed" now compares the levels on the page.** It compared the 5 strongest levels below the price over 12 months, while the page opens on every level from the last 200 sessions. Measured on 2026-10-23:

| Ticker | Levels "What changed" tracked | Levels the page shows at 1M |
|---|---|---|
| TQQQ | 5 below, including $49.22 and $45.62 | 6 below, with $50.18 and $45.97 in their place |
| QQQ | 5 below | 9 below |
| SPY | 5 below | 15 below |

So it could report a level that was not on the page and miss changes to ones that were. The nightly snapshot now uses the page's opening settings, kept in one place (`SR.PAGE_SETTINGS`) that the page uses too. Replayed over the last 70 sessions this reports fewer changes, not more (TQQQ 56 → 36, QQQ 33 → 15, SPY 32 → 21, at most 4 in one day), because a level moving in or out of the "top 5" is no longer a change. Snapshots saved before this change are rebuilt with the new settings when compared, so the first night after the merge does not report the difference in settings as a change; without that, it would have reported "$42.05 is now on the list of levels" on 2026-10-23. No data files change in this pull request; the next nightly run writes the new snapshots.

**The bottom line uses the card's width.** Its rows stopped at 92 characters, leaving the right half of the card empty on a wide screen. Lines across the full width would be about 190 characters, too long to read, so on screens 1280 pixels and wider the rows sit in two columns, and "Since the previous session" spans both. Measured at 1400 pixels wide: the card is 627 → 478 pixels tall, and the chart starts 150 pixels higher. Phones keep one column.

Also fixed: the stylesheet asked for a 16-pixel gap between the top bar and the first section, but the page-width rule cancelled it, so the first section touched the bar.

**Tests.** Page tests, on a desktop and a phone: the sections appear in this order with a gap below the top bar; the legend, switches, description and help sit below the chart in that order (both fail on the previous layout); "What changed" is the bottom line's last row, lists the day's items and stays after a window change; a quiet day is one line; the page opens on the settings the comparison uses. Unit tests: the snapshot keeps the same levels as the page for TQQQ, QQQ and SPY; the new wording when every level is kept; and an old-style previous snapshot is rebuilt (this test fails with the rebuild switched off).

## 15. Safari (twelfth pull request)

**What was asked.** A review of the test gaps found that every browser test ran in Chrome only. Add Safari.

**What changed in the tests.** The browser tests also run in WebKit, Safari's engine: every test as Safari on a Mac, and the layout and every-combination drawing tests as an iPhone 15. The GitHub runs install WebKit next to Chrome. The weekly run of all 256 switch settings now covers Safari too. Measured on an 8-core Mac, Safari and iPhone take 23 minutes against Chrome's 7, so the weekly run is split into one job per screen, run side by side, each within its own 60-minute limit.

**What Safari found.** 108 of 111 tests passed at once. The other three were two real problems, both fixed here:

| Problem in Safari | Cause, measured | Fix |
|---|---|---|
| Typing a ticker and pressing Enter did nothing; **Show** worked | With the suggestion list attached, Safari does not send Enter to the form. With the list removed, Enter worked | Enter sends the form itself if the browser has not done so by the next moment; opening a ticker twice is ignored |
| After moving a Method slider back and forth quickly, the bottom line, table and chart stopped following it | Safari refuses more than 100 changes of the page's address in 10 seconds, and the page changed it on every slider step. The error came after 105 steps; Chrome had none after 150 | The address is changed at most once every 250 ms, keeping the last one, and a refusal no longer stops the page from redrawing |

**Tests.** The Enter test already existed and failed in Safari before the fix. A new test moves a slider 160 steps quickly and checks that the levels follow it to the end, that the address changes at most once every 250 ms, and that there are no errors; it fails in Safari without the fix. Two tests that read the address straight after a click now wait up to 250 ms for it.

**Not covered.** Playwright's WebKit is Safari's engine, not Safari itself, and it cannot make real trackpad gestures. Whether pinching on a Mac trackpad zooms the chart in Safari still needs a person to try it.

## 16. The daily data moves to its own branch (thirteenth pull request)

**What was asked.** Stop the daily data refreshes committing to `main`, the same way as another project of the requester's (iHaveAnnuities): an orphan `market-data` branch that holds only the data, which the page reads from GitHub's raw-file address.

**Measured on the owner's repository before the change:** 46 of `main`'s 64 commits were data refreshes, since 2026-09-16. All 205 versions of the data files take 0.2 MB as git stores them (3.8 MB uncompressed); the whole repository is 0.4 MB. So the data branch stays in the same repository: what made `main` hard to read was the history, not the size, and a second repository would need a personal access token for the nightly job to write to it. GitHub's raw-file address allows any site to read it and is cached for 5 minutes (checked on the iHaveAnnuities branch).

| Part | Before | After |
|---|---|---|
| Where the data is | `docs/data` on `main` | `data/` on the `market-data` branch: no shared history with `main`, the same folder layout, so every ticker's `dir` is unchanged |
| Nightly refresh and add-ticker job | Commit to `main` | `pipeline/data_branch.sh get` checks the branch out at `.market-data/` and links `docs/data` to it, so the pipeline is unchanged; `put` commits there |
| The page | Reads `data/...` from the site | On `<owner>.github.io/<repo>/` it reads `https://raw.githubusercontent.com/<owner>/<repo>/market-data/data/...`; anywhere else (a local preview, the tests) its own `data/` folder |
| Lookup service | Read the list from the site (`SITE`) | Reads it from the data branch (`DATA_BRANCH`, default `market-data`); `SITE` is no longer needed |
| Tests | Read the live list | Read a frozen copy (`tests/fixtures/tickers.json`); they need neither the branch nor a network |
| Local preview | Worked straight away | `npm run data` first |

**Starting the branch.** The first run of either job in a repository without the branch creates it from `main`'s last copy of `docs/data` (the commit before this change removed it), so the history files carry over. The nightly refresh also runs when `refresh.yml` changes on `main`, so merging this starts the branch within minutes, without waiting for the evening. Until that run finishes, the page has no data to show.

**Checked.** In a scratch copy with its own remote: the first run created the branch from the last copy (no shared history with `main`), and a second run checked it out, ran the real snapshot job through the link and pushed only to the branch, leaving `main` untouched. The commit message step gives "Data revision: QQQ as of 2026-10-23", "Data revision: TQQQ, QQQ as of 2026-10-23", and "Start the market-data branch from main's docs/data" on the first run. The workflows themselves have not run on GitHub: the fork's scheduled workflows are switched off on purpose.

**Tests.** A browser test opens the page at a GitHub Pages address, with every request answered locally, and checks that the list, prices and what changed are asked of the branch's address and nothing of the site's `data/` folder, for TQQQ and for QQQ's folder; another checks the address for both GitHub Pages sites, a local preview and another host. The lookup service's tests answer the list only at the branch's address. All tests pass with no `docs/data` present, as on `main` after the merge.

## 18. Pre-market and after-hours price (fifteenth pull request)

**Asked for:** the after-hours price at the top, and a projected open.

**Measured first (2026-10-27, 5:53 New York).** Yahoo's chart API gives one-minute pre-market prices when asked for them: TQQQ at $68.64, against Monday's close of $68.43. Its `previousClose` field still gave Friday's close, $66.29, so measuring from it would have shown +3.5% instead of +0.3%. The change is measured from `regularMarketPrice`, the last regular close.

**Decided:**

| Option | Decision |
|---|---|
| Pre-market and after-hours price under **Last close** | Built |
| Projected open from Nasdaq-100 futures × 3 | Not built. The futures' previous close is taken at a different time from the 4 pm stock close, so the two changes do not start from the same point, and it would only estimate what the pre-market price already shows |

**How it works.** The lookup service has a new request, `GET /quote?symbol=X`, which reads Yahoo's one-minute prices for today and returns the newest one inside the pre-market (4:00–9:30 New York) or after-hours (16:00–20:00) session, its change from the last regular close, and when to ask again (a minute during those hours, else when they next start, at most an hour). The page asks once it has loaded and then when told to, and asks nothing while the tab is in the background. With no lookup service, nothing is asked and nothing is shown.

**Not checked yet:** a real after-hours reply. The saved reply is from the pre-market; the after-hours case is tested by adding after-hours minutes to it. That Yahoo's `regularMarketPrice` is that day's close during after hours is expected but not yet seen.

**Tests.** The lookup service against Yahoo's real reply (`tests/fixtures/yahoo-tqqq-premarket-2026-10-27.json`): the price, the close it is measured from, never a price later than now, the other sessions and when to ask again, and failures. In the browser, in Chrome and Safari's engine: the wording, up or down, updating when told to, no line and no error with no price or no service, nothing from the service shown as HTML, and the line fitting its card on a phone.

**Banner fix (same pull request).** Asked for after a preview showed Oct 23 data on Tuesday evening, Oct 27, with only a quiet "update pending" banner: the page waited until three sessions were missing before calling the data out of date. Now only today's close may be missing for "update pending"; any earlier missing session is "out of date". Checked against the record first: from Sep 21 to Oct 23, 2026 every session was published the same evening (at most 4.7 hours after the close; about 17 minutes since Sep 30), so the stricter rule does not fire on a normal day. The page did not know market holidays, so the morning after one would have read as out of date; it now follows the NYSE holiday rules, which match every trading day in two years of recorded prices (one one-off closure, Jan 9, 2025, is listed by date).

## 17. Order of work

| Order | Phase | Size |
|---|---|---|
| 1st | 3 — chart navigation | Small |
| 2nd | 1 — levels above price | Small |
| 3rd | 4 + 5 — Bollinger Bands and switches, done together | Medium |
| 4th | 2 — any ticker | Largest |

Each phase goes on its own branch with its own pull request, and gets a line in the README change log when it is merged.
