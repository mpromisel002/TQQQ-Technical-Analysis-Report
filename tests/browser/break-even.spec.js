// Your break-even: the visitor types their average price, the page keeps it in this browser
// only, and the first card says what QQQ has to do for TQQQ to get back to it.
const { test, expect } = require("@playwright/test");
const { openPage } = require("./helpers");

test("typing an average price shows QQQ's break-even, keeps it in this browser, and sends it nowhere", async ({ page }) => {
  const sent = [];
  page.on("request", (r) => sent.push(`${r.url()} ${r.postData() || ""}`));
  const errors = await openPage(page);
  const card = page.locator("#kpis .kpi").first();
  await expect(card.locator(".label")).toHaveText("Your break-even");
  await expect(card).toContainText("Kept in this browser only, never sent anywhere.");
  await page.locator("#avgInput").fill("$75");
  await page.locator("#avgInput").press("Enter");
  // TQQQ closed at $66.29, QQQ at 704.40: TQQQ needs +13.1%, so QQQ about +4.38%
  await expect(card.locator(".label")).toHaveText("Your break-even · TQQQ avg $75.00");
  await expect(card.locator(".value")).toHaveText("QQQ 735.25");
  await expect(card.locator(".delta").first()).toHaveText("QQQ needs 4.4% · 30.85 points from 704.40 · TQQQ +13.1%");
  await expect(card.locator(".ext")).toContainText("Over a month it can be off by ±0.7%, over 3 months ±2.3% (8 in 10 past cases): TQQQ resets daily.");
  expect(await page.evaluate(() => localStorage.getItem("avgPrice:TQQQ"))).toBe("75");
  // still there after a reload
  await page.reload();
  await expect(card.locator(".value")).toHaveText("QQQ 735.25");
  // never in a request or the link
  expect(sent.filter((s) => /\b75(\.0+)?\b/.test(s.replace(/^\S+\/(data|js|css)\/\S+/, "")))).toEqual([]);
  expect(page.url()).not.toContain("75");
  expect(errors).toEqual([]);
});

test("an average price below the close says how far QQQ can fall", async ({ page }) => {
  await openPage(page);
  await page.evaluate(() => localStorage.setItem("avgPrice:TQQQ", "60"));
  await page.reload();
  await page.waitForFunction(() => window.__dashboard && window.__dashboard.res);
  await expect(page.locator("#breakEven .delta").first()).toContainText("QQQ can fall 3.2%");
});

test("Change lets you edit the price, and saving it empty removes it", async ({ page }) => {
  await openPage(page);
  await page.locator("#avgInput").fill("75");
  await page.locator("#avgInput").press("Enter");
  await page.locator("#avgChange").click();
  await expect(page.locator("#avgInput")).toHaveValue("75");
  await expect(page.locator("#breakEven")).toContainText("Leave it empty to remove it.");
  await page.locator("#avgInput").fill("");
  await page.locator("#avgInput").press("Enter");
  await expect(page.locator("#breakEven .label")).toHaveText("Your break-even");
  expect(await page.evaluate(() => localStorage.getItem("avgPrice:TQQQ"))).toBeNull();
});

test("text that is not a price is not saved", async ({ page }) => {
  await openPage(page);
  await page.locator("#avgInput").fill("abc");
  await page.locator("#avgInput").press("Enter");
  expect(await page.evaluate(() => localStorage.getItem("avgPrice:TQQQ"))).toBeNull();
  await expect(page.locator("#avgInput")).toBeVisible();
});
