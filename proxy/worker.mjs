/*
 * Cloudflare Worker for the "any ticker" feature. Two jobs:
 *
 *   GET  /prices?symbol=XYZ   two years of daily prices for XYZ and its benchmark, adjusted
 *                             for splits and dividends, in the same shape as a data file, so
 *                             the page can show a ticker that is not on the daily list yet.
 *   POST /add?symbol=XYZ      asks GitHub to run the add-ticker job, which adds XYZ to the
 *                             daily list if it passes the same checks as the nightly refresh.
 *   GET  /quote?symbol=XYZ    XYZ's latest pre-market (4:00-9:30 New York) or after-hours
 *                             (16:00-20:00) price, against the last regular close, and when
 *                             to ask again. Outside those hours it says there is none.
 *
 * The page cannot fetch Yahoo itself: Yahoo does not allow requests from other websites.
 * Every answer that is not a success says why, in plain words, in `message`.
 *
 * Settings (see proxy/README.md): GITHUB_TOKEN (secret), GITHUB_REPO ("owner/name"),
 * GITHUB_REF (branch, default "main"), DATA_BRANCH (where the ticker list is, default "market-data"),
 * ALLOW_ORIGIN (default "*"), MAX_TICKERS (default 50), ADDS_PER_DAY (default 5),
 * and a KV namespace bound as LIMITS for the per-visitor limit.
 */

const MIN_SESSIONS = 260; // the same minimum the nightly refresh checks (pipeline/fetch.py)
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
const KINDS = { EQUITY: "stock", ETF: "fund" };

export default {
  fetch: (request, env) => handle(request, env),
};

/** The whole Worker, with `fetchImpl` replaceable so the tests need no network. */
export async function handle(request, env = {}, fetchImpl = fetch, now = new Date()) {
  const cors = {
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  const reply = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors, ...extra } });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYMBOL.test(symbol)) {
    return reply(400, { status: "rejected", message: `"${symbol.slice(0, 20)}" is not a ticker symbol: use 1 to 10 letters, digits, dots or dashes, starting with a letter.` });
  }

  if (url.pathname === "/prices" && request.method === "GET") {
    const got = await prices(symbol, fetchImpl, now);
    return got.payload ? reply(200, got.payload, { "Cache-Control": "public, max-age=900" }) : reply(got.status, got.error);
  }

  if (url.pathname === "/quote" && request.method === "GET") {
    const got = await quote(symbol, fetchImpl, now);
    return reply(got.status, got.body, got.status === 200 ? { "Cache-Control": "public, max-age=60" } : {});
  }

  if (url.pathname === "/add" && request.method === "POST") {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || !env.LIMITS) {
      return reply(503, { status: "not-set-up", message: "Adding tickers to the daily list is not switched on yet. You can still view any ticker live." });
    }
    // the ticker list lives on the data branch, with the daily data (pipeline/data_branch.sh)
    const listing = await fetchImpl(`https://raw.githubusercontent.com/${env.GITHUB_REPO}/${env.DATA_BRANCH || "market-data"}/data/tickers.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!listing) return reply(502, { status: "error", message: "Could not read the report's ticker list. Please try again later." });
    if (listing.tickers.some((t) => t.symbol === symbol)) return reply(200, { status: "listed", message: `${symbol} is already on the daily list.` });
    const max = Number(env.MAX_TICKERS || 50);
    if (listing.tickers.length >= max) {
      return reply(409, { status: "full", message: `The daily list is full (${max} tickers), so ${symbol} cannot be added. You can still view it live.` });
    }
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = `add:${ip}:${new Date().toISOString().slice(0, 10)}`;
    const used = Number((await env.LIMITS.get(key)) || 0), perDay = Number(env.ADDS_PER_DAY || 5);
    if (used >= perDay) {
      return reply(429, { status: "limit", message: `You have already asked for ${perDay} tickers to be added today. Please try again tomorrow.` });
    }
    const got = await prices(symbol, fetchImpl, now); // the same first checks as viewing it
    if (!got.payload) return reply(got.status, got.error);
    const gh = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/add-ticker.yml/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "support-levels-proxy", "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { symbol } }),
    });
    if (gh.status !== 204) return reply(502, { status: "error", message: `GitHub did not start the add-ticker job (answer ${gh.status}). Please try again later.` });
    await env.LIMITS.put(key, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
    return reply(202, { status: "requested", message: `${symbol} passed the first checks. The daily job is checking it now and will add it to the list within a few minutes if it passes.` });
  }

  return reply(404, { status: "rejected", message: "Unknown request. Use GET /prices?symbol=XYZ, GET /quote?symbol=XYZ or POST /add?symbol=XYZ." });
}

/**
 * Today's date in New York, and whether its session is still running: a bar for today is
 * not a close until 16:15 New York time, the same rule as pipeline/fetch.py.
 */
export function newYorkSession(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, running: Number(parts.hour) * 60 + Number(parts.minute) < 16 * 60 + 15 };
}

/** Two years of adjusted daily prices for `symbol` and its benchmark, or the reason there are none. */
export async function prices(symbol, fetchImpl = fetch, now = new Date()) {
  const benchmark = symbol === "SPY" ? "QQQ" : "SPY";
  const [own, bench] = await Promise.all([chart(symbol, fetchImpl), chart(benchmark, fetchImpl)]);
  const ny = newYorkSession(now);
  for (const c of [own, bench]) {
    if (!c.error && ny.running && c.dates[c.dates.length - 1] === ny.today) for (const k of ["dates", "open", "high", "low", "close", "volume"]) c[k].pop();
  }
  if (own.error) return { status: own.status, error: { status: "rejected", message: own.error } };
  if (bench.error) return { status: 502, error: { status: "error", message: `Could not fetch ${benchmark}, the comparison prices. Please try again later.` } };
  const kind = KINDS[own.meta.instrumentType];
  if (!kind) {
    return { status: 422, error: { status: "rejected", message: `${symbol} is not a stock or fund (Yahoo lists it as ${String(own.meta.instrumentType || "unknown").toLowerCase()}), so the report cannot cover it.` } };
  }
  if (own.dates.length < MIN_SESSIONS) {
    return { status: 422, error: { status: "rejected", message: `${symbol} has only ${own.dates.length} trading days of history; ${MIN_SESSIONS} are needed.` } };
  }
  // the benchmark on the ticker's own dates, carrying the last close over any gap
  const byDate = new Map(bench.dates.map((d, i) => [d, bench.close[i]]));
  let last = null;
  const benchClose = own.dates.map((d) => (byDate.has(d) ? (last = byDate.get(d)) : last));
  return {
    payload: {
      meta: {
        symbol, benchmark, name: own.meta.longName || own.meta.shortName || symbol, index: null, leverage: 1,
        as_of: own.dates[own.dates.length - 1], generated_utc: new Date().toISOString().slice(0, 19) + "Z",
        source: "Yahoo Finance, fetched live", rows: own.dates.length, warnings: [], adjusted: "splits and dividends", live: true,
      },
      dates: own.dates,
      series: { open: own.open, high: own.high, low: own.low, close: own.close, volume: own.volume, bench_close: benchClose },
    },
  };
}

/** One symbol's daily bars from Yahoo's chart API, adjusted, with unsettled bars dropped. */
async function chart(symbol, fetchImpl) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=div,split`;
  let body;
  try {
    const r = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 (support-levels-proxy)" } });
    body = await r.json();
  } catch (e) {
    return { status: 502, error: `Could not reach the price source for ${symbol}. Please try again later.` };
  }
  const res = body && body.chart && body.chart.result && body.chart.result[0];
  if (!res || !res.timestamp) return { status: 404, error: `No prices were found for ${symbol}. Check the symbol.` };
  const q = res.indicators.quote[0], adj = (res.indicators.adjclose || [{}])[0].adjclose || q.close;
  const off = (res.meta && res.meta.gmtoffset) || 0;
  const out = { meta: res.meta || {}, dates: [], open: [], high: [], low: [], close: [], volume: [] };
  res.timestamp.forEach((t, i) => {
    if (q.close[i] == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) return; // not settled yet
    const f = adj[i] != null ? adj[i] / q.close[i] : 1;
    out.dates.push(new Date((t + off) * 1000).toISOString().slice(0, 10));
    out.open.push(q.open[i] * f); out.high.push(q.high[i] * f); out.low.push(q.low[i] * f); out.close.push(q.close[i] * f);
    out.volume.push(q.volume[i] || 0);
  });
  return out;
}

const SESSIONS = { pre: "Pre-market", post: "After hours" };
const NONE_YET = { pre: "No pre-market prices yet.", post: "No after-hours prices yet." };

/**
 * The latest pre-market or after-hours price for `symbol`, from Yahoo's one-minute bars.
 * The change is measured from Yahoo's last regular close (regularMarketPrice): its
 * `previousClose` is the close before that one (checked 2026-10-27, when it still gave
 * Friday's close on Tuesday morning). `next` is how many seconds until it is worth asking
 * again: a minute during those hours, else until the next of them starts (at most an hour).
 */
export async function quote(symbol, fetchImpl = fetch, now = new Date()) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
  let body;
  try {
    const r = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 (support-levels-proxy)" } });
    body = await r.json();
  } catch (e) {
    return { status: 502, body: { status: "error", message: `Could not reach the price source for ${symbol}. Please try again later.` } };
  }
  const res = body && body.chart && body.chart.result && body.chart.result[0];
  const m = res && res.meta, periods = m && m.currentTradingPeriod;
  if (!periods || m.regularMarketPrice == null) return { status: 404, body: { status: "rejected", message: `No prices were found for ${symbol}. Check the symbol.` } };

  const t = Math.floor(now.getTime() / 1000);
  const session = ["pre", "regular", "post"].find((k) => periods[k] && periods[k].start <= t && t < periods[k].end) || "closed";
  const starts = ["pre", "post"].map((k) => periods[k] && periods[k].start).filter((x) => x > t);
  const next = session === "pre" || session === "post" ? 60 : Math.max(60, Math.min(3600, starts.length ? Math.min(...starts) - t : 3600));
  const close = m.regularMarketPrice;
  const closeDate = new Date((m.regularMarketTime + (m.gmtoffset || 0)) * 1000).toISOString().slice(0, 10);
  if (!SESSIONS[session]) {
    const why = session === "regular" ? "Regular trading hours: there is no pre-market or after-hours price to show." : "Pre-market and after-hours trading are closed.";
    return { status: 200, body: { status: "none", symbol, session, message: why, close, closeDate, next } };
  }
  // the newest one-minute bar inside this session, up to now
  const p = periods[session], ts = res.timestamp || [], c = (res.indicators && res.indicators.quote[0].close) || [];
  let last = -1;
  ts.forEach((x, i) => { if (x >= p.start && x < p.end && x <= t && c[i] != null) last = i; });
  if (last < 0) {
    return { status: 200, body: { status: "none", symbol, session, message: NONE_YET[session], close, closeDate, next } };
  }
  const price = c[last];
  return {
    status: 200,
    body: {
      status: "ok", symbol, session, label: SESSIONS[session], price, time: new Date(ts[last] * 1000).toISOString(),
      close, closeDate, changePct: (price / close - 1) * 100, next,
    },
  };
}
