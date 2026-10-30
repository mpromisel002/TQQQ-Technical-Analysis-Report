# Lookup service for any ticker

The report's page can show any stock or fund, not only the tickers on
the list (`data/tickers.json` on the `market-data` branch), and can ask for one to be added to the
daily list. The page cannot fetch prices from Yahoo itself — Yahoo does not allow requests
from other websites — so this small Cloudflare Worker ([`worker.mjs`](worker.mjs)) does it.

| Request | What it does |
|---|---|
| `GET /prices?symbol=DIA` | Two years of daily prices for DIA and its benchmark (SPY; QQQ for SPY), adjusted for splits and dividends, in the shape of a data file. Today's bar is left out until 16:15 New York time. The page works out the indicators itself (`docs/js/indicators.js`) |
| `GET /quote?symbol=TQQQ` | TQQQ's latest pre-market (4:00–9:30 New York) or after-hours (16:00–20:00) price from Yahoo's one-minute prices, its change from the last regular close, and how many seconds until it is worth asking again: 60 during those hours, else until they next start (at most an hour). Outside those hours it says there is none. The page shows it under **Last close** |
| `POST /add?symbol=DIA` | Starts the **Add a ticker** workflow ([`add-ticker.yml`](../.github/workflows/add-ticker.yml)), which adds DIA to the daily list only if it passes the same checks as the nightly refresh |

It turns a symbol away, with the reason in plain words, if it is not a symbol, has no prices,
is not a stock or fund, or has fewer than 260 trading days of history. Adding also stops when
the list has 50 tickers, or when one visitor has asked for 5 additions that day.

Until the Worker is set up, the page says that looking up other tickers is not switched on,
shows no pre-market or after-hours price, and everything else works as before.

## Setting it up (about 10 minutes)

You need: a free Cloudflare account, Node.js, and admin access to the report's GitHub
repository.

1. **Sign in to Cloudflare** from this folder:
   ```bash
   cd proxy
   npx wrangler login
   ```
2. **Create the store for the per-visitor limit**, and paste the `id` it prints into
   `wrangler.toml` where it says `PASTE-THE-ID-HERE`:
   ```bash
   npx wrangler kv namespace create LIMITS
   ```
3. **Check the settings** under `[vars]` in `wrangler.toml`: the repository (`GITHUB_REPO`),
   its branch, the branch holding the data (`DATA_BRANCH`) and the site allowed to call the Worker
   (`ALLOW_ORIGIN`).
4. **Create a GitHub token** that can only start workflows in this one repository:
   GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   Resource owner: the repository's owner. Repository access: **Only select repositories**,
   this one. Permissions: **Actions — Read and write**, nothing else. Then store it in the
   Worker (it asks you to paste it; it is never written to a file):
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
5. **Deploy**, and note the address it prints, such as
   `https://support-levels-proxy.<your-account>.workers.dev`:
   ```bash
   npx wrangler deploy
   ```
6. **Point the page at it:** put that address in `data/tickers.json` on the `market-data` branch as `"proxy"`, and
   commit.
7. **Try it:** open the report with `?ticker=DIA`. It should say DIA is shown live, with an
   **Add DIA to the daily list** button. After pressing it, the **Add a ticker** run appears
   in the repository's Actions tab. Between 4:00 and 9:30, or 16:00 and 20:00 New York time,
   a pre-market or after-hours price appears under **Last close**.

To switch adding off again, delete the token (`npx wrangler secret delete GITHUB_TOKEN`);
viewing tickers live keeps working. To switch the whole feature off, set `"proxy": ""`.

## Tests

`tests/worker.test.js` runs the Worker with a fake Yahoo and a fake GitHub (no network):
every reason for turning a symbol away, the 16:15 rule, the benchmark, starting the GitHub
job, the 50-ticker and 5-a-day limits, and "not switched on" until the settings exist.
