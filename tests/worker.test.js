// The Cloudflare Worker (proxy/worker.mjs), with a fake Yahoo and a fake GitHub: no network.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const load = () => import("../proxy/worker.mjs");
const fixture = (s) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `${s}-2026-10-23.json`), "utf8"));
const AFTER_CLOSE = new Date("2026-10-23T21:30:00Z"); // 17:30 New York: the 2026-10-23 bar is a close

/** A Yahoo chart reply made from a frozen data file (prices already adjusted, so adjclose = close). */
function yahooReply(p, { instrumentType = "ETF", rows } = {}) {
  const n = rows ?? p.dates.length, from = p.dates.length - n;
  const s = (k) => p.series[k].slice(from);
  return {
    chart: { result: [{
      meta: { instrumentType, longName: `${p.meta.symbol} test fund`, gmtoffset: -14400 },
      timestamp: p.dates.slice(from).map((d) => Date.parse(d + "T13:30:00Z") / 1000 + 14400),
      indicators: { quote: [{ open: s("open"), high: s("high"), low: s("low"), close: s("close"), volume: s("volume") }], adjclose: [{ adjclose: s("close") }] },
    }] },
  };
}

/** A fake fetch: Yahoo for QQQ/SPY/TQQQ, the ticker list on the data branch, and GitHub's dispatch endpoint. */
function fakeNet({ yahoo = {}, listing, github = 204 } = {}) {
  const calls = [];
  const reply = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    if (u.hostname === "query1.finance.yahoo.com") {
      const sym = decodeURIComponent(u.pathname.split("/").pop());
      if (yahoo[sym] === "missing") return reply(404, { chart: { result: null, error: { code: "Not Found" } } });
      const base = { QQQ: "qqq", SPY: "spy", TQQQ: "tqqq" }[sym] || "qqq";
      return reply(200, yahooReply(fixture(base), yahoo[sym] || {}));
    }
    if (String(url) === LIST_URL) return reply(200, listing || JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tickers.json"), "utf8")));
    if (u.hostname === "api.github.com") return reply(github, null);
    return reply(404, null);
  };
  return { impl, calls };
}

const ENV = { GITHUB_TOKEN: "t", GITHUB_REPO: "owner/repo", LIMITS: memoryKV() };
const LIST_URL = "https://raw.githubusercontent.com/owner/repo/market-data/data/tickers.json"; // the list is on the data branch
function memoryKV() { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), m }; }
const req = (method, q, ip = "1.2.3.4") => new Request(`https://proxy.test${q}`, { method, headers: { "CF-Connecting-IP": ip } });

test("prices: a fund's two years of prices and its benchmark, in the shape of a data file", async () => {
  const { handle } = await load();
  const { impl } = fakeNet();
  const r = await handle(req("GET", "/prices?symbol=dia"), {}, impl, AFTER_CLOSE);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  const p = await r.json();
  assert.equal(p.meta.symbol, "DIA");
  assert.equal(p.meta.benchmark, "SPY");
  assert.equal(p.meta.leverage, 1);
  assert.equal(p.meta.live, true);
  assert.equal(p.dates.length, 501);
  assert.equal(p.dates[p.dates.length - 1], "2026-10-23");
  for (const k of ["open", "high", "low", "close", "volume", "bench_close"]) assert.equal(p.series[k].length, 501, k);
  assert.equal(p.series.bench_close[500], fixture("spy").series.close[500]);
});

test("prices: SPY is compared with QQQ, as on the daily list", async () => {
  const { handle } = await load();
  const p = await (await handle(req("GET", "/prices?symbol=SPY"), {}, fakeNet().impl, AFTER_CLOSE)).json();
  assert.equal(p.meta.benchmark, "QQQ");
});

test("prices: today's bar is left out until 16:15 New York time", async () => {
  const { handle } = await load();
  const during = new Date("2026-10-23T18:00:00Z"); // 14:00 New York on 2026-10-23
  const p = await (await handle(req("GET", "/prices?symbol=DIA"), {}, fakeNet().impl, during)).json();
  assert.equal(p.dates[p.dates.length - 1], "2026-10-22");
});

test("prices: each reason for turning a symbol away is given in plain words", async () => {
  const { handle } = await load();
  const cases = [
    ["/prices?symbol=" + encodeURIComponent("$$$"), {}, 400, /is not a ticker symbol/],
    ["/prices?symbol=NOPE", { yahoo: { NOPE: "missing" } }, 404, /No prices were found for NOPE/],
    ["/prices?symbol=BTC-USD", { yahoo: { "BTC-USD": { instrumentType: "CRYPTOCURRENCY" } } }, 422, /not a stock or fund \(Yahoo lists it as cryptocurrency\)/],
    ["/prices?symbol=NEWCO", { yahoo: { NEWCO: { instrumentType: "EQUITY", rows: 140 } } }, 422, /only 140 trading days of history; 260 are needed/],
  ];
  for (const [q, net, status, message] of cases) {
    const r = await handle(req("GET", q), {}, fakeNet(net).impl, AFTER_CLOSE);
    assert.equal(r.status, status, q);
    assert.match((await r.json()).message, message, q);
  }
});

test("add: not switched on until the token, repository and limit store are set", async () => {
  const { handle } = await load();
  const r = await handle(req("POST", "/add?symbol=DIA"), {}, fakeNet().impl, AFTER_CLOSE);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).status, "not-set-up");
});

test("add: a good symbol starts the add-ticker job on GitHub", async () => {
  const { handle } = await load();
  const env = { ...ENV, LIMITS: memoryKV() };
  const net = fakeNet();
  const r = await handle(req("POST", "/add?symbol=dia"), env, net.impl, AFTER_CLOSE);
  assert.equal(r.status, 202);
  assert.equal((await r.json()).status, "requested");
  const gh = net.calls.find((c) => c.url.includes("api.github.com"));
  assert.equal(gh.url, "https://api.github.com/repos/owner/repo/actions/workflows/add-ticker.yml/dispatches");
  assert.equal(gh.init.headers.Authorization, "Bearer t");
  assert.deepEqual(JSON.parse(gh.init.body), { ref: "main", inputs: { symbol: "DIA" } });
});

test("add: already listed, list full, and GitHub refusing are each explained", async () => {
  const { handle } = await load();
  let r = await handle(req("POST", "/add?symbol=QQQ"), { ...ENV, LIMITS: memoryKV() }, fakeNet().impl, AFTER_CLOSE);
  assert.equal((await r.json()).status, "listed");
  const full = { default: "TQQQ", tickers: Array.from({ length: 50 }, (_, i) => ({ symbol: `T${i}` })) };
  r = await handle(req("POST", "/add?symbol=DIA"), { ...ENV, LIMITS: memoryKV() }, fakeNet({ listing: full }).impl, AFTER_CLOSE);
  assert.equal(r.status, 409);
  assert.match((await r.json()).message, /The daily list is full \(50 tickers\)/);
  r = await handle(req("POST", "/add?symbol=DIA"), { ...ENV, LIMITS: memoryKV() }, fakeNet({ github: 401 }).impl, AFTER_CLOSE);
  assert.equal(r.status, 502);
  assert.match((await r.json()).message, /GitHub did not start the add-ticker job \(answer 401\)/);
});

test("add: at most 5 requests per visitor per day; another visitor is not affected", async () => {
  const { handle } = await load();
  const env = { ...ENV, LIMITS: memoryKV() };
  for (let i = 0; i < 5; i++) assert.equal((await handle(req("POST", `/add?symbol=DIA`), env, fakeNet().impl, AFTER_CLOSE)).status, 202);
  const sixth = await handle(req("POST", "/add?symbol=DIA"), env, fakeNet().impl, AFTER_CLOSE);
  assert.equal(sixth.status, 429);
  assert.match((await sixth.json()).message, /already asked for 5 tickers to be added today/);
  assert.equal((await handle(req("POST", "/add?symbol=DIA", "5.6.7.8"), env, fakeNet().impl, AFTER_CLOSE)).status, 202);
});

test("a request the Worker does not know is answered, not ignored", async () => {
  const { handle } = await load();
  const r = await handle(req("GET", "/other?symbol=DIA"), {}, fakeNet().impl, AFTER_CLOSE);
  assert.equal(r.status, 404);
  assert.equal((await handle(req("OPTIONS", "/prices?symbol=DIA"), {}, fakeNet().impl)).status, 204);
});

// /quote: Yahoo's real one-minute reply for TQQQ, saved at 05:56 New York on 2026-10-27 (pre-market)
const PREMARKET = fs.readFileSync(path.join(__dirname, "fixtures", "yahoo-tqqq-premarket-2026-10-27.json"), "utf8");
const yahooQuote = (body = PREMARKET) => async (url) => {
  assert.match(String(url), /\/v8\/finance\/chart\/TQQQ\?range=1d&interval=1m&includePrePost=true$/);
  return new Response(body, { status: 200 });
};
const quoteAt = async (iso, fetchImpl = yahooQuote()) => {
  const { handle } = await load();
  const r = await handle(req("GET", "/quote?symbol=TQQQ"), {}, fetchImpl, new Date(iso));
  return { status: r.status, cache: r.headers.get("Cache-Control"), body: await r.json() };
};

test("quote: pre-market price against the last regular close, not Yahoo's previousClose", async () => {
  const q = await quoteAt("2026-10-27T09:53:00Z"); // 5:53 New York
  assert.equal(q.status, 200);
  assert.equal(q.cache, "public, max-age=60");
  assert.deepEqual({ ...q.body, changePct: q.body.changePct.toFixed(4) }, {
    status: "ok", symbol: "TQQQ", session: "pre", label: "Pre-market", price: 68.64, time: "2026-10-27T09:53:00.000Z",
    close: 68.43, closeDate: "2026-10-26", changePct: "0.3069", next: 60,
  });
  // the reply's previousClose is Friday's close; using it would give +3.5% instead
  assert.equal(JSON.parse(PREMARKET).chart.result[0].meta.previousClose, 66.29);
});

test("quote: the newest price up to now, never a later one", async () => {
  const q = await quoteAt("2026-10-27T08:00:10Z"); // 4:00 New York, with later bars in the reply
  assert.equal(q.body.price, 67.63);
  assert.equal(q.body.time, "2026-10-27T08:00:00.000Z");
});

test("quote: after hours with no prices yet, regular hours and closed each say so, and when to ask again", async () => {
  const post = await quoteAt("2026-10-27T21:00:00Z"); // 17:00 New York; the saved reply has only pre-market bars
  assert.deepEqual([post.body.status, post.body.session, post.body.message, post.body.next], ["none", "post", "No after-hours prices yet.", 60]);
  const open = await quoteAt("2026-10-27T19:30:00Z"); // 15:30: after hours starts in 30 minutes
  assert.deepEqual([open.body.status, open.body.session, open.body.next], ["none", "regular", 1800]);
  assert.equal(open.body.message, "Regular trading hours: there is no pre-market or after-hours price to show.");
  assert.equal((await quoteAt("2026-10-27T14:00:00Z")).body.next, 3600); // never more than an hour
  const night = await quoteAt("2026-10-28T01:00:00Z"); // 21:00
  assert.deepEqual([night.body.session, night.body.message, night.body.next], ["closed", "Pre-market and after-hours trading are closed.", 3600]);
});

test("quote: an after-hours price is read from the after-hours bars", async () => {
  const y = JSON.parse(PREMARKET), r = y.chart.result[0];
  const postStart = r.meta.currentTradingPeriod.post.start;
  r.timestamp.push(postStart + 60, postStart + 120);
  r.indicators.quote[0].close.push(68.1, null); // a minute with no price is skipped
  const q = await quoteAt("2026-10-27T20:05:00Z", yahooQuote(JSON.stringify(y)));
  assert.deepEqual([q.body.session, q.body.label, q.body.price, q.body.time], ["post", "After hours", 68.1, "2026-10-27T20:01:00.000Z"]);
  assert.ok(q.body.changePct < 0);
});

test("quote: an unknown symbol or an unreachable source is explained", async () => {
  const missing = await quoteAt("2026-10-27T09:53:00Z", async () => new Response(JSON.stringify({ chart: { result: null } }), { status: 404 }));
  assert.deepEqual([missing.status, missing.body.message], [404, "No prices were found for TQQQ. Check the symbol."]);
  const down = await quoteAt("2026-10-27T09:53:00Z", async () => { throw new Error("offline"); });
  assert.deepEqual([down.status, down.body.message], [502, "Could not reach the price source for TQQQ. Please try again later."]);
  assert.equal(down.cache, null); // a failure is not cached
});
