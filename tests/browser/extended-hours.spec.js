// The pre-market or after-hours price under "Last close", from the lookup service's /quote
// (a fake service here, answering with what proxy/worker.mjs gives for Yahoo's real reply).
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const { openPage } = require("./helpers");

const PROXY = "https://proxy.test";
const listing = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "tickers.json"), "utf8"));
const PREMARKET = fs.readFileSync(path.join(__dirname, "..", "fixtures", "yahoo-tqqq-premarket-2026-10-27.json"), "utf8");

/** What the real Worker answers at 5:53 New York on 2026-10-27, from Yahoo's saved reply. */
async function workerAnswer() {
  const { quote } = await import("../../proxy/worker.mjs");
  return (await quote("TQQQ", async () => new Response(PREMARKET), new Date("2026-10-27T09:53:00Z"))).body;
}

/** A lookup service that gives each /quote request the next answer in `answers` (the last one repeats). */
async function withQuotes(page, answers, { proxy = PROXY } = {}) {
  const asked = [];
  await page.route("**/data/tickers.json*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...listing, proxy }) }));
  await page.route(`${PROXY}/**`, (r) => {
    const u = new URL(r.request().url());
    asked.push(`${r.request().method()} ${u.pathname}?${u.searchParams}`);
    const a = answers[Math.min(asked.length, answers.length) - 1];
    if (a === "unreachable") return r.abort();
    return r.fulfill({ status: a.httpStatus || 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(a) });
  });
  return asked;
}

test("before the open, the pre-market price sits under the last close, with its change and time", async ({ page }) => {
  const asked = await withQuotes(page, [await workerAnswer()]);
  const errors = await openPage(page);
  const line = page.locator(".kpi #extHours");
  // the report's data ends Oct 23 and the change is from Yahoo's Oct 26 close: that close is
  // named, with its price, so the card's two prices are not read as one day's
  await expect(line).toHaveText("Pre-market $68.64 ▲ +0.31%from the Oct 26 close of $68.43, which this report does not include yet · 5:53 am New York time");
  await expect(line.locator("span")).toHaveClass("up");
  // it is part of the Last close card, which now says which day's close it shows
  await expect(page.locator(".kpi").first()).toContainText("Last close · Oct 23$66.29▼ -0.20% on the day");
  expect(asked).toEqual(["GET /quote?symbol=TQQQ"]);
  expect(errors).toEqual([]);
});

test("after hours, a fall is shown in red with a down arrow", async ({ page }) => {
  await withQuotes(page, [{ status: "ok", symbol: "TQQQ", session: "post", price: 65.1, time: "2026-10-23T22:41:00Z", close: 66.29, closeDate: "2026-10-23", changePct: -1.796, next: 60 }]);
  const errors = await openPage(page);
  const line = page.locator("#extHours");
  // the close it is measured from is the report's own, so it is only named
  await expect(line).toHaveText("After hours $65.10 ▼ -1.80%from the Oct 23 close · 6:41 pm New York time");
  await expect(line.locator("span")).toHaveClass("down");
  expect(errors).toEqual([]);
});

test("during regular hours, overnight, or with the service down, there is no line and nothing breaks", async ({ page }) => {
  for (const answer of [
    { status: "none", symbol: "TQQQ", session: "regular", message: "Regular trading hours: there is no pre-market or after-hours price to show.", next: 1800 },
    { status: "none", symbol: "TQQQ", session: "closed", message: "Pre-market and after-hours trading are closed.", next: 3600 },
    { httpStatus: 502, status: "error", message: "Could not reach the price source for TQQQ. Please try again later." },
  ]) {
    await page.unrouteAll();
    const asked = await withQuotes(page, [answer]);
    const errors = await openPage(page);
    await expect.poll(() => asked.length).toBe(1);
    await expect(page.locator("#extHours")).toHaveCount(0);
    await expect(page.locator(".kpi").first()).toContainText("$66.29");
    expect(errors.filter((e) => !/502/.test(e))).toEqual([]); // the browser itself logs the 502
  }
});

test("a lookup service that cannot be reached shows no line and no error on the page", async ({ page }) => {
  const asked = await withQuotes(page, ["unreachable"]);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await openPage(page);
  await expect.poll(() => asked.length).toBe(1);
  await expect(page.locator("#extHours")).toHaveCount(0);
  await expect(page.locator("#blHeadline")).toContainText("TQQQ closed at $66.29");
  expect(pageErrors).toEqual([]);
});

test("without a lookup service in the list, nothing is asked", async ({ page }) => {
  const asked = await withQuotes(page, [await workerAnswer()], { proxy: "" });
  const errors = await openPage(page);
  await page.waitForTimeout(500);
  expect(asked).toEqual([]);
  await expect(page.locator("#extHours")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the price is asked for again when the service says to, and the line updates", async ({ page }) => {
  const first = await workerAnswer();
  const asked = await withQuotes(page, [{ ...first, next: 5 }, { ...first, price: 68.9, changePct: 0.6722, time: "2026-10-27T09:58:00Z" }]);
  await openPage(page);
  await expect(page.locator("#extHours")).toContainText("Pre-market $68.64");
  await expect(page.locator("#extHours")).toContainText("Pre-market $68.90 ▲ +0.67%", { timeout: 10000 });
  await expect(page.locator("#extHours")).toContainText("· 5:58 am");
  expect(asked).toEqual(["GET /quote?symbol=TQQQ", "GET /quote?symbol=TQQQ"]);
});

test("another ticker asks for its own price", async ({ page }) => {
  const asked = await withQuotes(page, [{ ...(await workerAnswer()), symbol: "QQQ" }]);
  await openPage(page, "?ticker=QQQ");
  await expect(page.locator("#extHours")).toBeVisible();
  expect(asked).toEqual(["GET /quote?symbol=QQQ"]);
});

test("text from the service never reaches the page as HTML", async ({ page }) => {
  const bad = "<img src=x id=injected>";
  await withQuotes(page, [{ status: "ok", session: "pre", price: 68.64, changePct: 0.3, time: "2026-10-27T09:53:00Z", closeDate: bad, label: bad, symbol: bad }]);
  await openPage(page);
  await expect(page.locator("#extHours")).toHaveText("Pre-market $68.64 ▲ +0.30%from the last close · 5:53 am New York time");
  for (const a of [{ session: bad }, { price: bad }, { time: bad }]) {
    await page.unrouteAll();
    await withQuotes(page, [{ status: "ok", session: "pre", price: 68.64, changePct: 0.3, time: "2026-10-27T09:53:00Z", ...a }]);
    await openPage(page);
    await page.waitForTimeout(300);
    await expect(page.locator("#extHours")).toHaveCount(0);
  }
  await expect(page.locator("#injected")).toHaveCount(0);
});

test("on a phone the line fits inside its card", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await withQuotes(page, [await workerAnswer()]);
  await openPage(page);
  await expect(page.locator("#extHours")).toBeVisible();
  const fit = await page.evaluate(() => {
    const card = document.querySelector("#extHours").closest(".kpi"), line = document.querySelector("#extHours");
    const c = card.getBoundingClientRect(), l = line.getBoundingClientRect();
    return { inside: l.left >= c.left && l.right <= c.right + 0.5 && l.bottom <= c.bottom, sideways: document.documentElement.scrollWidth - innerWidth };
  });
  expect(fit).toEqual({ inside: true, sideways: 0 });
});
