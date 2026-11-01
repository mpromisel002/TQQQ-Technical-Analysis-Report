// "Selling covered calls": the card built from the option prices recorded at the close
// (pipeline/options.py). Uses the prices and option prices of the Oct 30, 2026 close.
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const { openPage, renderingProblems, OPTIONS } = require("./helpers");

const OCT30 = fs.readFileSync(path.join(__dirname, "..", "fixtures", "tqqq-2026-10-30.json"), "utf8");
const AT = "2026-10-30T20:00:00-04:00";
const open = (page, query = "", o = {}) => openPage(page, query, { data: OCT30, changes: "[]", now: AT, ...o });

test("the card suggests calls at the levels above the price, one expiry at a time", async ({ page }) => {
  const errors = await open(page);
  const card = page.locator("#ccCard");
  await expect(page.locator("#ccContext")).toHaveText(
    "Last close $62.01 on Oct 30, 2026. Option prices from the same close (recorded Oct 31, 7:53 pm New York time). "
    + "Levels above the price: A1 $66.59, A2 $70.26, A3 $75.47. Nearest floor below: S1 $57.48, -7.3%. Tap a row to read it in words.");
  // the monthly is shown first
  const expiry = page.locator("#ccExpiry button");
  await expect(expiry).toHaveText(["Nov 6 · 7d", "Nov 13 · 14d", "Nov 20 · 21d · monthly", "Nov 27 · 28d"]);
  await expect(page.locator('#ccExpiry button[aria-checked="true"]')).toHaveText("Nov 20 · 21d · monthly");
  // the plan's worked example: the Nov 20 $67 call
  await expect(card.locator('tr.cc-row[data-r="0"] td')).toHaveText(["$67at A1 $66.59 · 30% pick", "$2.16 3.5%61% a year", "+8.0%1.3 typical days",
    "30%", "$59.85", "+11.5%", "normal$2.16 / $2.52 · 183 open"]);
  await expect(card.locator("tr.cc-row td:first-child b")).toHaveText(["$67", "$70", "$70.50", "$75.50"]); // strike order
  // another expiry: the $0.25 / $1.20 call is marked thin, in its strike's place
  await expiry.nth(1).click();
  await expect(page.locator('#ccExpiry button[aria-checked="true"]')).toHaveText("Nov 13 · 14d");
  await expect(card.locator("tr.cc-row td:first-child b")).toHaveText(["$67", "$69", "$71", "$75.50"]);
  await expect(card.locator("tr.cc-row").nth(2).locator(".thin-tag")).toHaveText("thin");
  await expect(card.locator("tr.cc-row").nth(2)).toContainText("$0.25 / $1.20");
  await expect(page.locator("#ccWarn")).toContainText("TQQQ is 3× leveraged");
  await expect(page.locator("#ccThinDef")).toContainText("wider than 50% of the middle price, or open interest under 100");
  expect(await renderingProblems(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("a tap or the keyboard opens a row's sentence", async ({ page }) => {
  await open(page);
  const row = page.locator('tr.cc-row[data-r="0"]');
  const say = row.locator("xpath=following-sibling::tr[1]");
  await expect(say).toBeHidden();
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(say).toHaveText(/^Sell the Nov 20 \$67 call for about \$2\.16 a share \(3\.5%\)\. If TQQQ is above \$67 on Nov 20, about a 30% chance/);
  await row.click();
  await expect(say).toBeHidden();
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(say).toBeVisible();
});

test("the card follows the settings: other levels, other strikes", async ({ page }) => {
  await open(page, "?period=2");
  const levels = await page.evaluate(() => window.__dashboard.cc.levels.map((l) => l.id + " " + l.price.toFixed(2)));
  expect(levels.length).toBeGreaterThan(0);
  await expect(page.locator("#ccContext")).toContainText(`Levels above the price: ${levels.join(", ").replace(/ (\d)/g, " $$$1")}.`);
});

test("option prices from another close are not mixed with this report", async ({ page }) => {
  await openPage(page); // the report is from Oct 23; the option prices from Oct 30
  await expect(page.locator("#ccContext")).toHaveText(
    "The option prices on file are from the Oct 30, 2026 close, but this report is from the Oct 23, 2026 close, so no calls are suggested until the two match.");
  await expect(page.locator("#ccTable")).toBeHidden();
  await expect(page.locator("#ccWarn")).toBeVisible();
});

test("a ticker with no option prices recorded says so", async ({ page }) => {
  await open(page, "", { options: null });
  await expect(page.locator("#ccContext")).toHaveText("No option prices are recorded for TQQQ yet. They are recorded each night after the close.");
  await expect(page.locator("#ccTable")).toBeHidden();
  await openPage(page, "?ticker=QQQ");
  await expect(page.locator("#ccContext")).toHaveText("No option prices are recorded for QQQ yet. They are recorded each night after the close.");
  await expect(page.locator("#ccWarn")).not.toContainText("leveraged");
});

test("nothing from the options file is shown as HTML", async ({ page }) => {
  const bad = JSON.parse(OPTIONS);
  bad.meta.fetched_utc = '<img src=x onerror="window.__hit=1">';
  bad.expiries[2].date = '<img src=x onerror="window.__hit=1">';
  bad.expiries[0].calls[0].strike = '<img src=x onerror="window.__hit=1">';
  bad.expiries[0].calls[1].open_interest = "<b>lots</b>";
  await open(page, "", { options: JSON.stringify(bad) });
  await expect(page.locator("#ccTable")).toBeVisible();
  expect(await page.locator("#ccCard img, #ccCard b:has-text('lots')").count()).toBe(0);
  expect(await page.evaluate(() => window.__hit)).toBeUndefined();
});

test("at phone width the table scrolls inside the card, not the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.locator("#ccTable")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
