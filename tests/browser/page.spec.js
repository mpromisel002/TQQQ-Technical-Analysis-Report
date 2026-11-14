// The report renders every section from the frozen data, and every control works.
const { test, expect } = require("@playwright/test");
const { openPage } = require("./helpers");

test("page renders every section with no errors", async ({ page }) => {
  const errors = await openPage(page, "?window=12m");
  await expect(page.locator("#blHeadline")).toContainText("TQQQ closed at $66.29");
  await expect(page.locator("#asOf")).toContainText(/Oct 23, 2026|2026-10-23/);
  await expect(page.locator("#kpis .kpi")).toHaveCount(7); // your break-even first, then six
  await expect(page.locator("#blRows dt").first()).toHaveText("Nearest floor");
  // the 12-month window looks back 252 sessions and lists every level below the price, nearest first
  const ids = await page.locator("#levels tbody .lvl.support").allTextContents();
  expect(ids).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
  await expect(page.locator("#levels tbody tr", { hasText: "S1" })).toContainText("$66.72");
  await page.locator("#findingsSummary").click();
  expect(await page.locator("#findings li, #findings p").count()).toBeGreaterThanOrEqual(10);
  for (const id of ["#mainChart", "#cmpChart", "#benchChart"]) await expect(page.locator(`${id} canvas`)).toBeVisible();
  await expect(page.locator("#indTable tbody tr").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the page opens on the 1-month window", async ({ page }) => {
  const errors = await openPage(page);
  await expect(page.locator('#windowSeg button[data-w="1m"]')).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => window.__dashboard.res.opts.window)).toBe(21);
  expect(new URL(page.url()).searchParams.get("window")).toBe("1m");
  // the window sets the chart view; levels still come from the last 200 sessions
  await expect(page.locator("#levels tbody tr.price-row")).toContainText("levels from the last 200 sessions");
  await expect(page.locator("#levels tbody .lvl.support")).toHaveCount(6);
  await expect(page.locator("#blHeadline")).toContainText("sitting on its nearest floor");
  expect(errors).toEqual([]);
});

test("a missing data file shows a message instead of a blank page", async ({ page }) => {
  await openPage(page, "", { data: null });
  await expect(page.locator("#blHeadline")).toContainText("Could not load the data file");
  await expect(page.locator("#asOf")).toHaveText("Data unavailable");
});

test("window buttons change the analysis and the page address", async ({ page }) => {
  const errors = await openPage(page);
  for (const [key, sessions] of [["1m", 21], ["3m", 63], ["6m", 126], ["9m", 189], ["12m", 252]]) {
    await page.locator(`#windowSeg button[data-w="${key}"]`).click();
    await expect(page.locator(`#windowSeg button[data-w="${key}"]`)).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => new URL(page.url()).searchParams.get("window")).toBe(key); // written within URL_GAP (250 ms)
    expect(await page.evaluate(() => window.__dashboard.res.opts.window)).toBe(sessions);
  }
  // a custom number of sessions, clamped to the allowed range
  await page.locator("#customWin").fill("40");
  await page.locator("#customWin").press("Enter");
  expect(await page.evaluate(() => window.__dashboard.res.opts.window)).toBe(40);
  expect(errors).toEqual([]);
});

test("settings in the page address are applied on load", async ({ page }) => {
  await openPage(page, "?window=3m&period=4");
  expect(await page.evaluate(() => window.__dashboard.res.opts)).toMatchObject({ window: 63, period: 4 });
  await expect(page.locator("#periodText")).toHaveText("4");
});

test("method settings sliders recalculate, and Reset puts the defaults back", async ({ page }) => {
  const errors = await openPage(page);
  await page.locator("#settings summary").click();
  await page.locator("#period").fill("5");
  await expect(page.locator("#periodOut")).toHaveText("5 days");
  await expect(page.locator("#periodHelp")).toContainText("lowest of the 5 trading days before it and the 5 after");
  await expect(page.locator("#periodText")).toHaveText("5");
  expect(await page.evaluate(() => window.__dashboard.res.opts.period)).toBe(5);
  await page.locator("#resetSettings").click();
  expect(await page.evaluate(() => window.__dashboard.res.opts.period)).toBe(3);
  expect(errors).toEqual([]);
});

test("panel switches show and hide chart panels, and are remembered", async ({ page }) => {
  const errors = await openPage(page);
  const panes = () => page.evaluate(() => window.__dashboard.charts.main.o.panes.map((p) => p.id));
  expect(await panes()).toEqual(["price", "vol", "rsi"]);
  await page.locator('input[data-pane="macd"]').check();
  await page.locator('input[data-pane="vol"]').uncheck();
  expect(await panes()).toEqual(["price", "rsi", "macd"]);
  await page.reload();
  await page.waitForFunction(() => window.__dashboard && window.__dashboard.res);
  expect(await panes()).toEqual(["price", "rsi", "macd"]);
  await expect(page.locator('input[data-pane="vol"]')).not.toBeChecked();
  expect(errors).toEqual([]);
});

test("theme button switches between light and dark", async ({ page }) => {
  const errors = await openPage(page);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme || "auto");
  const before = await theme();
  await page.locator("#themeBtn").click();
  expect(await theme()).not.toBe(before);
  expect(errors).toEqual([]);
});

test("CSV download holds the levels and the daily rows", async ({ page }) => {
  await openPage(page, "?window=12m");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#dlCsv").click()]);
  expect(download.suggestedFilename()).toBe("tqqq-support-2026-10-23-252d.csv");
  const text = require("fs").readFileSync(await download.path(), "utf8");
  const lines = text.split("\n");
  expect(lines[1]).toMatch(/^level,zone_price,/);
  expect(lines.filter((l) => /^S\d,/.test(l))).toHaveLength(7);
  expect(lines.filter((l) => /^\d{4}-\d{2}-\d{2},/.test(l))).toHaveLength(252);
});

test("PNG download produces an image", async ({ page }) => {
  await openPage(page, "?window=12m");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#dlPng").click()]);
  expect(download.suggestedFilename()).toMatch(/^tqqq-support-2026-10-23-252d\.png$/);
});

test("moving a method slider quickly keeps the page up to date (Safari limits address changes)", async ({ page }) => {
  const errors = await openPage(page);
  await page.evaluate(() => {
    window.__writes = 0;
    const real = history.replaceState.bind(history);
    history.replaceState = (...a) => { window.__writes++; return real(...a); };
  });
  await page.locator("#settings summary").click();
  await page.locator("#cluster").focus();
  const started = Date.now();
  for (let pass = 0; pass < 3; pass++) for (const key of ["ArrowRight", "ArrowLeft"]) for (let i = 0; i < 25; i++) await page.keyboard.press(key);
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight"); // the last pass stops at 0.25, the lowest; 10 steps up is 0.75
  const seconds = (Date.now() - started) / 1000;
  await expect(page.locator("#clusterOut")).toHaveText("0.75 × a typical day");
  const g = await page.evaluate(() => ({ used: window.__dashboard.res.opts.clusterMult, writes: window.__writes }));
  expect(g.used).toBe(0.75);                                   // the levels follow the slider to the end
  expect(g.writes).toBeLessThanOrEqual(Math.ceil(seconds * 4) + 1); // at most one address change every 250 ms
  await expect.poll(() => new URL(page.url()).searchParams.get("cluster")).toBe("0.75");
  expect(errors).toEqual([]);                                  // Safari threw after 100 changes in 10 seconds
});

test("each method setting says in words what it does, with today's dollar figures", async ({ page }) => {
  await openPage(page);
  await page.locator("#settings summary").click();
  for (const [id, name] of [["period", "Days either side of a low"], ["cluster", "Zone width"], ["touches", "Minimum touches"]]) {
    await expect(page.locator(`label[for="${id}"]`)).toContainText(name);
    await expect(page.locator(`#${id}`)).toHaveAccessibleDescription(/\w+ \w+ \w+/);
  }
  // 0.5 x TQQQ's ATR on the frozen Oct 23 data, the same width the levels table states
  const r = await page.evaluate(() => window.__dashboard.res);
  await expect(page.locator("#clusterMoney")).toHaveText(`$${r.tol.toFixed(2)}`);
  await expect(page.locator("#clusterAtr")).toHaveText(`$${r.atr.toFixed(2)} for TQQQ now`);
  await expect(page.locator(".price-row")).toContainText(`zones are $${r.tol.toFixed(2)} wide`);
});
