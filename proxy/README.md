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

## Setting it up

Two ways. **In the browser** needs nothing installed and is the one in use today. **From the
command line** keeps the deployed Worker and this folder in step, and is worth the extra setup
if you expect to change `worker.mjs`.

Either way you need a free Cloudflare account and admin access to the report's GitHub
repository, and either way steps A and B below are the same.

### A. The GitHub token

The token is only needed for **Add a ticker**; viewing any ticker live works without it.

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
Resource owner: the repository's owner. Repository access: **Only select repositories**, this
one. Permissions: **Actions — Read and write**, nothing else. When it expires the Add button
stops working and live viewing carries on.

### B. Point the page at the Worker

Put the Worker's address in `data/tickers.json` on the `market-data` branch as `"proxy"`, and
commit. **No trailing slash:** the page builds `` `${proxy}/prices` ``, so a trailing slash
asks for `//prices`, which no route matches and every call fails with a bare 404. GitHub
caches raw addresses for about 5 minutes, so wait that long before testing.

### In the browser (Cloudflare dashboard)

1. **Workers & Pages → Create → Create Worker.** Name it `support-levels-proxy`, deploy the
   starter, then **Edit code**: replace everything with the contents of `worker.mjs` and
   deploy. Do **not** connect this GitHub repository to the Worker — Cloudflare then builds
   the repository as a static site and publishes `docs/` at the Worker's address, so
   `worker.mjs` never runs: the report's own page is served at `/`, and every other path
   returns an empty 404.
2. **Settings → Variables and Secrets:** add the `[vars]` from `wrangler.toml` as plain text
   (`GITHUB_REPO`, `GITHUB_REF`, `DATA_BRANCH`, `ALLOW_ORIGIN`, `MAX_TICKERS`,
   `ADDS_PER_DAY`), and the token from A as a **Secret** named `GITHUB_TOKEN`.
3. **Storage & Databases → KV → Create namespace** called `LIMITS`, then **Settings →
   Bindings → Add → KV namespace**, variable name `LIMITS`, pointing at it.
4. Do B, then **Try it** below.

`wrangler.toml` is not read by this route: it stays in the repository as the record of what
the settings should be, and `PASTE-THE-ID-HERE` stays as it is, because the namespace is
bound in the dashboard rather than by id here.

**This route copies the code rather than referencing it, so the two drift apart: after any
change to `worker.mjs`, paste it into the editor again or the live Worker keeps the old
version.** Nothing warns you.

### From the command line (wrangler)

Also needs Node.js. Run these **from this folder**: `wrangler deploy` from the repository
root does not find `wrangler.toml`, which is the file naming `worker.mjs` as the Worker.

```bash
cd proxy
npx wrangler login
npx wrangler kv namespace create LIMITS   # paste the id it prints into wrangler.toml
npx wrangler secret put GITHUB_TOKEN      # the token from A; never written to a file
npx wrangler deploy                       # note the address it prints
```

Check the `[vars]` in `wrangler.toml` first: the repository (`GITHUB_REPO`), its branch, the
branch holding the data (`DATA_BRANCH`) and the site allowed to call the Worker
(`ALLOW_ORIGIN`). Then do B.

### Try it

```bash
curl -s "https://support-levels-proxy.<your-account>.workers.dev/prices?symbol=DIA" | head -c 60
```

Expect JSON beginning `{"meta":{"symbol":"DIA"`. An **empty** 404 means the Worker is not
running `worker.mjs` — see the warning in step 1 above. `worker.mjs` answers every path with
JSON, including unknown ones.

Then open the report with `?ticker=DIA`. It should say DIA is shown live, with an **Add DIA to
the daily list** button. After pressing it, the **Add a ticker** run appears in the
repository's Actions tab. Between 4:00 and 9:30, or 16:00 and 20:00 New York time, a
pre-market or after-hours price appears under **Last close**.

### Switching it off

Adding only: delete the secret (`npx wrangler secret delete GITHUB_TOKEN`, or remove it under
Variables and Secrets); viewing tickers live keeps working. The whole feature: set
`"proxy": ""` in `data/tickers.json` on the `market-data` branch.

### A note on `ALLOW_ORIGIN`

It sets the `Access-Control-Allow-Origin` header, which stops other *websites* calling the
Worker from a browser. It is not access control: a direct request still reaches it. The limits
that matter are the ones in the Worker — `MAX_TICKERS`, `ADDS_PER_DAY` per visitor, and `/add`
only ever starting a workflow that repeats its own checks.

## Tests

`tests/worker.test.js` runs the Worker with a fake Yahoo and a fake GitHub (no network):
every reason for turning a symbol away, the 16:15 rule, the benchmark, starting the GitHub
job, the 50-ticker and 5-a-day limits, and "not switched on" until the settings exist.
