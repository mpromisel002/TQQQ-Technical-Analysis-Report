// Your break-even: the visitor types their average price, the page keeps it in this browser
// only, and the first card says what QQQ has to do for TQQQ to get back to it.
const { test, expect } = require("@playwright/test");
const { openPage } = require("./helpers");

test("typing an average price shows QQQ's break-even, keeps it in this browser, and sends it nowhere", async ({ page }) => {
  const sent = [];
  page.on("request", (r) => sent.push(`${r.url()} ${r.postData() || ""}`));
  const errors = await openPage(page);
  const card = page.locator("#kpis .kpi").first();
  await expect(card.locator(".label")).toHaveText("Break-even");
  await expect(card).toContainText("Kept in this browser only, never sent anywhere.");
  await page.locator("#avgInput").fill("$75");
  await page.locator("#avgInput").press("Enter");
  // TQQQ closed at $66.29, QQQ at 704.40: TQQQ needs +13.1%, so QQQ about +4.38%
  await expect(card.locator(".label")).toHaveText("Break-even Down 11.6%Change"); // Change sits top right
  // below the average: a red "Down" chip, and the moves needed in red
  await expect(card.locator(".be-chip")).toHaveClass(/below/);
  await expect(card.locator("thead th").nth(2)).toHaveText("Move needed");
  await expect(card.locator("thead th").nth(3)).toHaveText("$ move");
  expect(await card.locator("td.be-pct").evaluateAll((td) => td.map((x) => x.className))).toEqual(["be-pct down", "be-pct down"]);
  const rows = () => card.locator(".be-table tbody tr").evaluateAll((tr) => tr.map((r) => [...r.cells].map((c) => c.textContent)));
  expect(await rows()).toEqual([
    ["TQQQ", "$75.00", "+13.1%", "+$8.71"],
    ["QQQ", "$735.25", "+4.4%", "+$30.85"],
  ]);
  await expect(card.locator(".ext")).toHaveText("Drift: 3 months ±2.3% (±0.7%/month)");
  expect(await page.evaluate(() => localStorage.getItem("avgPrice:TQQQ"))).toBe("75");
  // still there after a reload
  await page.reload();
  await expect(card.locator(".be-table tbody tr")).toHaveCount(2); // drawn after the reload
  expect((await rows())[1]).toEqual(["QQQ", "$735.25", "+4.4%", "+$30.85"]);
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
  const rows = await page.locator("#breakEven .be-table tbody tr").evaluateAll((tr) => tr.map((r) => [...r.cells].map((c) => c.textContent)));
  expect(rows).toEqual([["TQQQ", "$60.00", "-9.5%", "-$6.29"], ["QQQ", "$682.12", "-3.2%", "-$22.28"]]);
  // above the average: a green "Up" chip, and how far it can fall, in green
  await expect(page.locator("#breakEven .be-chip")).toHaveText("Up 10.5%");
  await expect(page.locator("#breakEven .be-chip")).toHaveClass(/above/);
  await expect(page.locator("#breakEven thead th").nth(2)).toHaveText("Room to fall");
  expect(await page.locator("#breakEven td.be-pct").evaluateAll((td) => td.map((x) => x.className))).toEqual(["be-pct up", "be-pct up"]);
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
  await expect(page.locator("#breakEven .label")).toHaveText("Break-even");
  expect(await page.evaluate(() => localStorage.getItem("avgPrice:TQQQ"))).toBeNull();
});

test("text that is not a price is not saved", async ({ page }) => {
  await openPage(page);
  await page.locator("#avgInput").fill("abc");
  await page.locator("#avgInput").press("Enter");
  expect(await page.evaluate(() => localStorage.getItem("avgPrice:TQQQ"))).toBeNull();
  await expect(page.locator("#avgInput")).toBeVisible();
});

test("an average price at the close shows a grey At break-even chip", async ({ page }) => {
  await openPage(page);
  await page.evaluate(() => localStorage.setItem("avgPrice:TQQQ", "66.29")); // TQQQ closed at $66.29
  await page.reload();
  await page.waitForFunction(() => window.__dashboard && window.__dashboard.res);
  await expect(page.locator("#breakEven .be-chip")).toHaveText("At break-even");
  await expect(page.locator("#breakEven thead th").nth(2)).toHaveText("Move");
});
