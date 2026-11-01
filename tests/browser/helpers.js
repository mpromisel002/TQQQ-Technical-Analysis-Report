// Shared set-up: serve the frozen data instead of the live files, fix the clock to
// the evening of the fixture's last session, and collect every error the page reports.
const path = require("path");
const fs = require("fs");

const FIX = path.join(__dirname, "..", "fixtures");
const DATA = fs.readFileSync(path.join(FIX, "tqqq-2026-10-23.json"), "utf8");
const CHANGES = fs.readFileSync(path.join(FIX, "changes-2026-10-23.json"), "utf8");
// the ticker list and its other tickers, frozen the same day (the live ones are on the
// market-data branch, not main)
const LIST = fs.readFileSync(path.join(FIX, "tickers.json"), "utf8");
// option prices recorded at the Oct 30 close; the frozen prices above are from Oct 23, so by
// default the covered-call card says the two are from different closes
const OPTIONS = fs.readFileSync(path.join(FIX, "options-tqqq-2026-10-30.json"), "utf8");
const OTHER = Object.fromEntries(["qqq", "spy"].map((s) => [s, {
  data: fs.readFileSync(path.join(FIX, `${s}-2026-10-23.json`), "utf8"),
  changes: fs.readFileSync(path.join(FIX, `changes-${s}-2026-10-23.json`), "utf8"),
}]));

async function openPage(page, query = "", { data = DATA, changes = CHANGES, options = OPTIONS, now = "2026-10-23T20:00:00-04:00" } = {}) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.clock.setFixedTime(new Date(now));
  // on the context, so a test's own page.route for the list takes precedence
  await page.context().route("**/data/tickers.json*", (r) => r.fulfill({ contentType: "application/json", body: LIST }));
  await page.route("**/data/tqqq.json*", (r) => (data === null
    ? r.fulfill({ status: 404, body: "" })
    : r.fulfill({ contentType: "application/json", body: data })));
  await page.route("**/data/changes.json*", (r) => r.fulfill({ contentType: "application/json", body: changes }));
  // the other tickers have no option prices here: answered "null", which the page reads as none
  await page.route("**/data/**/options.json*", (r) => r.fulfill({ contentType: "application/json", body: "null" }));
  await page.route("**/data/options.json*", (r) => r.fulfill({ contentType: "application/json", body: options === null ? "null" : options }));
  for (const [s, f] of Object.entries(OTHER)) {
    await page.route(`**/data/${s}/${s}.json*`, (r) => r.fulfill({ contentType: "application/json", body: f.data }));
    await page.route(`**/data/${s}/changes.json*`, (r) => r.fulfill({ contentType: "application/json", body: f.changes }));
  }
  await page.goto("index.html" + query);
  if (data !== null) {
    try {
      await page.waitForFunction(() => window.__dashboard && window.__dashboard.res, null, { timeout: 10000 });
    } catch (e) {
      const state = await page.evaluate(() => ({
        ready: document.readyState, dashboard: !!window.__dashboard, webdriver: navigator.webdriver,
        headline: document.querySelector("#blHeadline")?.textContent, asOf: document.querySelector("#asOf")?.textContent,
        scripts: [...document.scripts].map((s) => s.src),
      }));
      throw new Error(`page did not finish loading: ${JSON.stringify(state)}; errors: ${JSON.stringify(errors)}`);
    }
  }
  return errors;
}

/** The main chart's visible range, in bars: { from, to }. */
const view = (page) => page.evaluate(() => ({ ...window.__dashboard.charts.main.view }));

/** Scroll the chart into view and move the mouse to the middle of the price pane. */
async function overChart(page) {
  const canvas = page.locator("#mainChart canvas");
  await canvas.evaluate((c) => c.scrollIntoView({ block: "start" }));
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 150);
  return box;
}

module.exports = { openPage, view, overChart, DATA, OPTIONS };

/**
 * Checks the main chart as drawn and returns a list of problems in plain words (empty = fine):
 * tags overlapping each other or a candle, the last-price tag off its price, a tag moved off
 * its line without a line back to it, date labels colliding,
 * candles cut off at the top or bottom, panels or legend not matching the switches, and the
 * count of levels out of view not matching the levels.
 */
async function renderingProblems(page) {
  return page.evaluate(() => {
    const st = window.__dashboard, c = st.charts.main, L = c.L, P = L.panes[0], S = P.S;
    const d = st.view.data, out = [];
    const boxes = st.tagBoxes || [];
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    // 1. tags overlapping each other
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
      if (hit(boxes[i], boxes[j])) out.push(`tags "${boxes[i].text}" and "${boxes[j].text}" overlap`);
    // 2. a tag covering a candle (body or wick) in view
    const cw = Math.max(1, Math.min(12, S.barW * 0.7));
    for (let i = S.i0; i <= S.i1; i++) {
      if (d.high[i] == null) continue;
      const candle = { left: S.x(i) - cw / 2, right: S.x(i) + cw / 2, top: S.y(d.high[i]), bottom: S.y(d.low[i]) };
      for (const b of boxes) if (hit(b, candle)) out.push(`tag "${b.text}" covers the ${d.dates[i]} candle`);
    }
    // 3. the last-price tag sits on its price; any other tag moved off its line has a line back to it
    for (const b of boxes) {
      if (b.target == null) continue;
      const off = Math.abs(b.y - b.target);
      if (/^\$/.test(b.text) && off > 1) out.push(`the last-price tag "${b.text}" is ${off.toFixed(0)}px off its price`);
      else if (off > 2 && !b.leader) out.push(`tag "${b.text}" is ${off.toFixed(0)}px from its line with nothing joining them`);
    }
    // 4. tags outside the price panel
    for (const b of boxes) if (b.top < S.top - 1 || b.bottom > S.bottom + 1) out.push(`tag "${b.text}" is outside the price panel`);
    // 5. candles cut off at the top or bottom of the price panel
    for (let i = Math.ceil(c.view.from); i <= Math.floor(c.view.to); i++) {
      if (d.high[i] == null) continue;
      if (d.high[i] > S.hi + 1e-9 || d.low[i] < S.lo - 1e-9) { out.push(`the ${d.dates[i]} candle is cut off`); break; }
    }
    // 6. date labels colliding or running off the chart
    const ctx = document.createElement("canvas").getContext("2d");
    const ticks = (c.ticks || []).map((t) => {
      ctx.font = t.strong ? '600 12px system-ui, -apple-system, "Segoe UI", sans-serif' : '12px system-ui, -apple-system, "Segoe UI", sans-serif';
      const w = ctx.measureText(t.label).width;
      return { ...t, left: t.x - w / 2, right: t.x + w / 2 };
    });
    for (let k = 1; k < ticks.length; k++) if (ticks[k].left < ticks[k - 1].right) out.push(`dates "${ticks[k - 1].label}" and "${ticks[k].label}" overlap`);
    for (const t of ticks) if (t.left < 0 || t.right > L.w) out.push(`date "${t.label}" runs off the chart`);
    // 7. panels and legend match the switches
    const want = ["price", ...["vol", "rsi", "macd", "dd"].filter((k) => st.panes[k])];
    const have = L.panes.map((p) => p.id);
    if (JSON.stringify(have) !== JSON.stringify(want)) out.push(`panels ${have.join(",")} but switches say ${want.join(",")}`);
    // each legend entry on its own, so "20-day avg" is not found inside the Bollinger entry
    const entries = [...document.querySelectorAll("#legend li")].map((li) => li.textContent.trim());
    const legendHas = (text) => entries.some((e) => e.startsWith(text) || e.endsWith(text)); // "3-day rolling low", "Bollinger Bands (…)"
    for (const [k, text] of [["bb", "Bollinger"], ["rolling", "rolling low"],
      ["sma20", "20-day avg"], ["sma50", "50-day avg"], ["sma200", "200-day avg"], ["swings", "Swing low"]])
      if (!!st.panes[k] !== legendHas(text)) out.push(`legend ${legendHas(text) ? "shows" : "is missing"} "${text}" with the switch ${st.panes[k] ? "on" : "off"}`);
    // 8. every level has its own tag or is counted in the edge tag on its side, never both or neither
    // S1 and A1 are always drawn; the two level switches add the rest
    const expectLv = { below: st.panes.zones ? st.res.supports : st.res.supports.slice(0, 1), above: st.panes.above ? st.res.above : st.res.above.slice(0, 1) };
    const shown = st.shownLevels || { below: [], above: [] };
    for (const side of ["below", "above"]) {
      const a = shown[side].map((z) => z.id).join(","), b = expectLv[side].map((z) => z.id).join(",");
      if (a !== b) out.push(`levels ${side} the price drawn: ${a || "none"}; switches say ${b || "none"}`);
    }
    for (const [list, text] of [[expectLv.below, "Support zone"], [expectLv.above, "Level above price"]])
      if ((list.length > 0) !== legendHas(text)) out.push(`legend ${legendHas(text) ? "shows" : "is missing"} "${text}" with ${list.length} drawn`);
    const levels = [...expectLv.below, ...expectLv.above];
    const money = (v) => "$" + v.toFixed(2);
    const tagged = new Set(boxes.filter((b) => !b.edge).map((b) => b.text));
    const untagged = levels.filter((z) => !tagged.has(`${z.id} ${money(z.price)}`));
    const priceY = S.y(st.res.price);
    const below = untagged.filter((z) => S.y(z.price) > priceY).length, above = untagged.length - below;
    const off = st.offChart || { above: 0, below: 0 };
    if (off.below !== below || off.above !== above) out.push(`edge tags count ${off.above} above / ${off.below} below, but ${above} / ${below} levels have no tag`);
    for (const [dir, n] of [["▲", above], ["▼", below]]) {
      const has = boxes.some((b) => b.edge && b.text.startsWith(dir));
      if (has !== n > 0) out.push(n ? `${n} levels have no tag and no ${dir} edge tag` : `a ${dir} edge tag with no level behind it`);
    }
    return out;
  });
}

module.exports.renderingProblems = renderingProblems;
