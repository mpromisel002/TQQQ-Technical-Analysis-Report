// On GitHub Pages the page reads its data from the market-data branch (GitHub's raw-file
// address), not from the site, because the daily data is no longer committed to main.
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");

const DOCS = path.join(__dirname, "..", "..", "docs");
const FIX = path.join(__dirname, "..", "fixtures");
const SITE = "https://owner.github.io/TQQQ-Technical-Analysis-Report/";
const RAW = "https://raw.githubusercontent.com/owner/TQQQ-Technical-Analysis-Report/market-data/";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
// what the branch holds, as of 2026-10-23 (no option prices: the page says so on the card)
const BRANCH = {
  "data/tickers.json": "tickers.json", "data/tqqq.json": "tqqq-2026-10-23.json", "data/changes.json": "changes-2026-10-23.json",
  "data/qqq/qqq.json": "qqq-2026-10-23.json", "data/qqq/changes.json": "changes-qqq-2026-10-23.json",
  "data/spy/spy.json": "spy-2026-10-23.json", "data/spy/changes.json": "changes-spy-2026-10-23.json",
};

async function openOnPages(page, query = "") {
  const asked = [], errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(new Date("2026-10-23T20:00:00-04:00"));
  await page.route("https://owner.github.io/**", (r) => {
    const rel = decodeURIComponent(new URL(r.request().url()).pathname).replace("/TQQQ-Technical-Analysis-Report/", "") || "index.html";
    asked.push("site " + rel);
    const file = path.join(DOCS, rel);
    if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return r.fulfill({ status: 404, body: "" });
    return r.fulfill({ contentType: TYPES[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
  });
  await page.route("https://raw.githubusercontent.com/**", (r) => {
    const url = r.request().url().split("?")[0];
    asked.push("branch " + url.replace(RAW, ""));
    const name = url.startsWith(RAW) && BRANCH[url.slice(RAW.length)];
    // GitHub sends these as plain text, from any site
    return name
      ? r.fulfill({ contentType: "text/plain; charset=utf-8", headers: { "Access-Control-Allow-Origin": "*" }, body: fs.readFileSync(path.join(FIX, name)) })
      : r.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "404: Not Found" });
  });
  await page.goto(SITE + "index.html" + query);
  await page.waitForFunction(() => window.__dashboard && window.__dashboard.res, null, { timeout: 10000 });
  return { asked, errors };
}

test("on GitHub Pages the list, prices and what changed come from the market-data branch", async ({ page }) => {
  const { asked, errors } = await openOnPages(page);
  await expect(page.locator("#blHeadline")).toContainText("TQQQ closed at $66.29");
  await expect(page.locator("#blChanges #changes li")).toHaveCount(1);
  expect(asked.filter((a) => a.startsWith("branch "))).toEqual(["branch data/tickers.json", "branch data/tqqq.json", "branch data/changes.json", "branch data/options.json"]);
  expect(asked.filter((a) => a.startsWith("site data/"))).toEqual([]); // nothing asked of the site's own data/ folder
  expect(errors).toEqual([]);
});

test("on GitHub Pages another ticker's files come from its folder on the branch", async ({ page }) => {
  const { asked, errors } = await openOnPages(page, "?ticker=QQQ");
  await expect(page.locator("#blHeadline")).toContainText("QQQ closed at $704.40");
  expect(asked).toContain("branch data/qqq/qqq.json");
  expect(asked).toContain("branch data/qqq/changes.json");
  expect(errors).toEqual([]);
});

test("the data address: the branch on GitHub Pages, the site's own folder anywhere else", async ({ page }) => {
  await page.goto("index.html");
  const got = await page.evaluate(() => [
    "https://mpromisel002.github.io/TQQQ-Technical-Analysis-Report/",
    "https://jimzucker.github.io/TQQQ-Technical-Analysis-Report/index.html?ticker=QQQ",
    "http://127.0.0.1:8123/index.html",
    "https://example.com/report/",
  ].map((u) => SR.dataBase(new URL(u))));
  expect(got).toEqual([
    "https://raw.githubusercontent.com/mpromisel002/TQQQ-Technical-Analysis-Report/market-data/",
    "https://raw.githubusercontent.com/jimzucker/TQQQ-Technical-Analysis-Report/market-data/",
    "", "",
  ]);
});
