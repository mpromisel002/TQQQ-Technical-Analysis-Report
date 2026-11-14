// QQQ's figures under four of TQQQ's summary cards, from QQQ's own data file.
const { test, expect } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const { openPage } = require("./helpers");

const card = (page, name) => page.locator("#kpis .kpi", { has: page.locator(".label", { hasText: name }) });

test("QQQ's close, supports and distance from its high sit under TQQQ's, and not under Trend", async ({ page }) => {
  const errors = await openPage(page);
  await expect(page.locator("#kpis .kpi-sub")).toHaveCount(4);
  await expect(card(page, "Last close").locator(".kpi-sub")).toHaveText(/^QQQ\s*\$704\.40 [-+]?\d+\.\d\d%$/);
  await expect(card(page, "Nearest support").locator(".kpi-sub")).toHaveText(/^QQQ\s*\$\d+\.\d\d · (in zone|-?\d+\.\d%)$/);
  await expect(card(page, "Strongest support").locator(".kpi-sub")).toHaveText(/^QQQ\s*\$\d+\.\d\d · \d+\/100$/);
  await expect(card(page, "From 12-month high").locator(".kpi-sub")).toHaveText(/^QQQ\s*-\d+\.\d% · \$\d+\.\d\d$/);
  // they line up across the row
  const tops = await page.locator("#kpis .kpi-sub").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  // and so do the lines under each big figure (Trend's coloured word once sat 3.5px lower)
  const deltas = await page.locator("#kpis .kpi:not(.be) > .delta").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(deltas).size).toBe(1);
  await expect(card(page, "Trend").locator(".kpi-sub")).toHaveCount(0);
  // the figures are QQQ's own analysis
  const q = await page.evaluate(() => ({ s: window.__dashboard.benchRes.supports[0].price, dd: window.__dashboard.benchLab.drawdown }));
  await expect(card(page, "Nearest support").locator(".kpi-sub")).toContainText(`$${q.s.toFixed(2)}`);
  await expect(card(page, "From 12-month high").locator(".kpi-sub")).toContainText(`${q.dd.toFixed(1)}%`);
  expect(errors).toEqual([]);
});

test("when QQQ's file ends on a different day, the cards show no QQQ lines", async ({ page }) => {
  const p = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "qqq-2026-10-23.json"), "utf8"));
  p.dates = p.dates.slice(0, -1);
  for (const k of Object.keys(p.series)) p.series[k] = p.series[k].slice(0, -1);
  const errors = await openPage(page);
  // set after openPage, whose own route for this file would otherwise win
  await page.route("**/data/qqq/qqq.json*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(p) }));
  await page.reload();
  await page.waitForFunction(() => window.__dashboard && window.__dashboard.res);
  expect(await page.evaluate(() => window.__dashboard.bench)).toBeFalsy();
  await expect(page.locator("#kpis .kpi")).toHaveCount(6);
  await expect(page.locator("#kpis .kpi-sub")).toHaveCount(0);
  expect(errors).toEqual([]);
});
