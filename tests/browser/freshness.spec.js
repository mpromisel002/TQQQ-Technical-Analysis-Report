// What the page says about how current its data is. The data ends at Friday Oct 23, 2026's
// close; the clock is set to different New York times around it.
const { test, expect } = require("@playwright/test");
const { openPage } = require("./helpers");

async function openAt(page, nyTime) {
  const errors = await openPage(page);
  await page.clock.setFixedTime(new Date(nyTime));
  await page.reload();
  await page.waitForFunction(() => window.__dashboard && window.__dashboard.res, null, { timeout: 10000 });
  return errors;
}

test("Friday evening with Friday's close: no banner", async ({ page }) => {
  const errors = await openAt(page, "2026-10-23T20:00:00-04:00");
  await expect(page.locator("#asOf")).toHaveText("Data as of Oct 23, 2026 close");
  await expect(page.locator("#stale")).toBeHidden();
  expect(errors).toEqual([]);
});

test("Monday after the close, only Monday's close missing: update pending", async ({ page }) => {
  await openAt(page, "2026-10-26T17:00:00-04:00");
  await expect(page.locator("#asOf")).toHaveText("Data as of Oct 23, 2026 close · update pending");
  await expect(page.locator("#stale")).toHaveText("Today's session has closed. This report rebuilds after the close, so today's figures usually appear within a few hours. Until then you are looking at the Oct 23, 2026 close.");
  await expect(page.locator("#stale")).toHaveClass(/info/);
});

test("Tuesday morning, Monday's close missing: out of date", async ({ page }) => {
  await openAt(page, "2026-10-27T10:00:00-04:00");
  await expect(page.locator("#asOf")).toHaveText("Data as of Oct 23, 2026 close");
  await expect(page.locator("#asOf")).toHaveClass(/stale/);
  await expect(page.locator("#stale")).toHaveText("Out of date: this report is missing the Oct 26, 2026 close. The daily refresh may have failed, so the levels below may be out of date.");
  await expect(page.locator("#stale")).not.toHaveClass(/info/);
});

test("Tuesday evening, Monday's and Tuesday's closes missing: out of date, not pending", async ({ page }) => {
  await openAt(page, "2026-10-27T21:00:00-04:00");
  await expect(page.locator("#asOf")).toHaveClass(/stale/);
  await expect(page.locator("#stale")).toHaveText("Out of date: this report is missing 2 trading days, up to the Oct 27, 2026 close. The daily refresh may have failed, so the levels below may be out of date.");
});
