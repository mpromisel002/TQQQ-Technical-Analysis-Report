// Any ticker: shown live through the lookup service (a fake one here), and asking for it to
// be added to the daily list. The fake serves QQQ's frozen prices under the name DIA, with
// the stored indicators removed, so the page has to work them out itself.
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const { openPage, renderingProblems } = require("./helpers");

const PROXY = "https://proxy.test";
const listing = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "tickers.json"), "utf8"));
const REF = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "indicators-reference.json"), "utf8"));

function livePayload() {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "qqq-2026-10-23.json"), "utf8"));
  const keep = ["open", "high", "low", "close", "volume", "bench_close"];
  p.series = Object.fromEntries(keep.map((k) => [k, p.series[k]]));
  p.meta = { ...p.meta, symbol: "DIA", name: "Dow Jones Industrial Average fund", index: null, leverage: 1, benchmark: "SPY", live: true };
  return p;
}

async function withProxy(page, { prices = 200, add = { status: 202, body: { status: "requested", message: "DIA passed the first checks. The daily job is checking it now and will add it to the list within a few minutes if it passes." } } } = {}) {
  const asked = [];
  await page.route("**/data/tickers.json*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...listing, proxy: PROXY }) }));
  await page.route(`${PROXY}/**`, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/quote") { // the pre-market and after-hours price: covered in extended-hours.spec.js
      return r.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ status: "none", session: "closed", next: 3600 }) });
    }
    asked.push(`${r.request().method()} ${u.pathname}?${u.searchParams}`);
    if (u.pathname === "/prices") {
      return prices === 200
        ? r.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(livePayload()) })
        : r.fulfill({ status: prices, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ status: "rejected", message: "NEWCO has only 140 trading days of history; 260 are needed." }) });
    }
    return r.fulfill({ status: add.status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(add.body) });
  });
  return asked;
}

test("a ticker not on the list is shown live, with its indicators worked out on the page", async ({ page }) => {
  const asked = await withProxy(page);
  const errors = await openPage(page, "?ticker=DIA");
  expect(asked).toEqual(["GET /prices?symbol=DIA"]);
  await expect(page.locator("#tickerNoteText")).toContainText("DIA is not on the daily list yet. It is shown live from today's prices");
  await expect(page.locator("#tickerInput")).toHaveValue("DIA");
  await expect(page.locator("h1")).toHaveText("DIA support levels");
  await expect(page.locator("#blHeadline")).toContainText("DIA closed at $704.40");
  await expect(page.locator("#tickerDesc")).toHaveText("Dow Jones Industrial Average fund"); // no index known
  // the page's own indicators equal Python's on the same prices
  const rsi = await page.evaluate(() => window.__dashboard.data.rsi14.slice(-3));
  REF.qqq.rsi14.slice(-3).forEach((v, i) => expect(Math.abs(rsi[i] - v)).toBeLessThan(1e-8));
  expect(await renderingProblems(page)).toEqual([]);
  await expect(page.locator("#changes")).toContainText("No comparison available yet");
  expect(errors).toEqual([]);
});

test("Add to the daily list asks the lookup service and shows its answer", async ({ page }) => {
  const asked = await withProxy(page);
  await openPage(page, "?ticker=DIA");
  await page.locator("#addTicker").click();
  await expect(page.locator("#tickerNoteText")).toHaveText("DIA passed the first checks. The daily job is checking it now and will add it to the list within a few minutes if it passes.");
  await expect(page.locator("#addTicker")).toBeHidden();
  expect(asked).toContain("POST /add?symbol=DIA");
});

test("when adding is not switched on yet, the page says so plainly", async ({ page }) => {
  await withProxy(page, { add: { status: 503, body: { status: "not-set-up", message: "Adding tickers to the daily list is not switched on yet. You can still view any ticker live." } } });
  await openPage(page, "?ticker=DIA");
  await page.locator("#addTicker").click();
  await expect(page.locator("#tickerNoteText")).toHaveText("Adding tickers to the daily list is not switched on yet. You can still view any ticker live.");
});

test("a ticker the lookup service turns away gives its reason, and the default is shown", async ({ page }) => {
  await withProxy(page, { prices: 422 });
  const errors = await openPage(page, "?ticker=NEWCO");
  await expect(page.locator("#tickerNoteText")).toHaveText("NEWCO has only 140 trading days of history; 260 are needed. TQQQ is shown instead.");
  await expect(page.locator("#tickerInput")).toHaveValue("TQQQ");
  await expect(page.locator("#addTicker")).toBeHidden();
  expect(errors.filter((e) => !/status of 422/.test(e))).toEqual([]); // the browser logs the 422 itself
});

test("the ticker field opens any ticker, and turns away text that is not a symbol", async ({ page }) => {
  await withProxy(page);
  await openPage(page);
  await page.locator("#tickerInput").fill("$$$");
  await page.locator("#tickerInput").press("Enter");
  await expect(page.locator("#tickerNoteText")).toHaveText('"$$$" is not a ticker symbol: use 1 to 10 letters, digits, dots or dashes, starting with a letter.');
  await page.locator("#tickerInput").fill("dia");
  await Promise.all([page.waitForNavigation(), page.locator("#tickerInput").press("Enter")]);
  await page.waitForFunction(() => window.__dashboard && window.__dashboard.res);
  expect(new URL(page.url()).searchParams.get("ticker")).toBe("DIA");
  await expect(page.locator("#tickerInput")).toHaveValue("DIA");
});
