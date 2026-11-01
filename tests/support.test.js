// Unit tests for docs/js/support.js (support-only method) — run with: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const SR = require("../docs/js/support.js");

// A frozen copy of docs/data/tqqq.json (as of 2026-10-23). The live file is rewritten
// every weekday, so tests that read it would check different numbers each day.
const FIXTURE = path.join(__dirname, "fixtures", "tqqq-2026-10-23.json");

// synthetic series helper: builds a data object from closes with a fixed spread
function synth(lows, { spread = 1, vol = 1000 } = {}) {
  const n = lows.length;
  const high = lows.map((l) => l + spread);
  const close = lows.map((l) => l + spread / 2);
  const ones = (v) => Array(n).fill(v);
  return {
    dates: lows.map((_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)),
    open: close.slice(), high, low: lows.slice(), close,
    volume: ones(vol), atr14: ones(2), sma50: ones(null), sma200: ones(null),
  };
}

// flat indicator series, so labels() / findings() / bottomLine() can run on synthetic prices
function fakeIndicators(n) {
  const ones = (v) => Array(n).fill(v);
  return {
    sma20: ones(null), sma50: ones(null), sma200: ones(null), rsi14: ones(50),
    macd: ones(0), macd_signal: ones(0), macd_hist: ones(0), bb_upper: ones(null), bb_lower: ones(null),
    vol_avg20: ones(1000), drawdown: ones(-10), qqq_close: Array.from({ length: n }, (_, i) => 100 + i),
  };
}

test("normalize clamps settings and understands presets", () => {
  assert.equal(SR.normalize({ window: "6m" }).window, 126);
  assert.equal(SR.normalize({ window: 5000 }).window, 252);
  assert.equal(SR.normalize({ window: 3 }).window, 21);
  assert.equal(SR.normalize({ period: 50 }).period, 10);
  assert.equal(SR.normalize({ clusterMult: 0.1 }).clusterMult, 0.25);
  assert.equal(SR.normalize({ minTouches: "x" }).minTouches, 1);
});

test("findPivots: 3-day swing low needs 3 higher lows on each side", () => {
  const lows = [10, 9, 8, 5, 8, 9, 10, 9, 8, 7];
  const { confirmed, pending } = SR.findPivots(lows, 3);
  assert.deepEqual(confirmed, [3]);
  assert.deepEqual(pending, [9]); // last bar is the lowest of its 3 prior bars but not yet confirmed
});

test("findPivots: equal lows count once (earliest)", () => {
  const lows = [9, 9, 9, 5, 5, 9, 9, 9, 9];
  assert.deepEqual(SR.findPivots(lows, 3).confirmed, [3]);
});

test("findPivots: swing highs", () => {
  const highs = [1, 2, 3, 9, 3, 2, 1, 2];
  assert.deepEqual(SR.findPivots(highs, 3, 0, "high").confirmed, [3]);
});

test("findPivots respects period 2 vs 3", () => {
  const lows = [10, 9, 6, 9, 7, 9, 10, 11];
  assert.deepEqual(SR.findPivots(lows, 2).confirmed, [2]);
  assert.deepEqual(SR.findPivots(lows, 1).confirmed, [2, 4]);
});

test("rollingLow is the min of the last k lows", () => {
  assert.deepEqual(SR.rollingLow([5, 4, 6, 7, 3], 3), [null, null, 4, 4, 3]);
});

test("cluster merges prices within tolerance and volume-weights them", () => {
  const prices = [10, 10.4, 20, 10.2];
  const vols = [100, 300, 100, 100];
  const z = SR.cluster([0, 1, 2, 3], prices, vols, 1);
  assert.equal(z.length, 2);
  assert.equal(z[0].members.length, 3);
  assert.ok(Math.abs(z[0].price - (10 * 100 + 10.4 * 300 + 10.2 * 100) / 500) < 1e-9);
});

test("strengthTier buckets the 0-100 score", () => {
  assert.equal(SR.strengthTier(85), "Strong");
  assert.equal(SR.strengthTier(70), "Strong");
  assert.equal(SR.strengthTier(55), "Moderate");
  assert.equal(SR.strengthTier(12), "Weak");
});

test("analyze finds a double-bottom support and scores it higher than a single touch", () => {
  // two dips to ~50, one dip to ~60, price ends at 70
  const path = [];
  const dip = (bottom, top) => { for (let i = 0; i < 6; i++) path.push(top - (top - bottom) * (i / 5)); for (let i = 4; i >= 0; i--) path.push(top - (top - bottom) * (i / 5)); };
  for (let r = 0; r < 3; r++) path.push(80);
  dip(50, 80); dip(50.5, 80); dip(60, 80);
  for (let r = 0; r < 10; r++) path.push(70);
  const d = synth(path);
  const res = SR.analyze(d, { window: 252 });
  const s50 = res.supports.find((z) => Math.abs(z.price - 50.25) < 1);
  const s60 = res.supports.find((z) => Math.abs(z.price - 60) < 1);
  assert.ok(s50, "double bottom found");
  assert.equal(s50.touches, 2);
  assert.ok(s60);
  assert.ok(s50.components.touches > s60.components.touches);
  // every reported support is a floor: no zone sits clearly above the last close
  assert.ok(res.supports.every((z) => z.low - res.tol / 2 <= res.price));
  assert.deepEqual(res.supports.map((z) => z.id), res.supports.map((_, i) => "S" + (i + 1)));
  assert.deepEqual([...res.supports].sort((a, b) => b.price - a.price).map((z) => z.id), res.supports.map((z) => z.id));
});

test("no resistance is reported anywhere in the output", () => {
  const d = synth([70, 69, 68, 60, 68, 69, 70, 71, 72, 73, 74, 73, 72, 71, 70]);
  const res = SR.analyze(d, { window: 252 });
  assert.equal(res.resistances, undefined);
  assert.equal(res.pivots.highs, undefined);
  assert.ok(!("role" in res.zones[0]));
  assert.ok(Array.isArray(res.broken));
});

test("a support that price closed below moves from the support list to the levels above price", () => {
  const path = [70, 69, 68, 60, 68, 69, 70, 69, 68, 67, 66, 65, 60, 55, 54, 53, 52, 52, 52];
  const d = synth(path);
  const res = SR.analyze(d, { window: 252 });
  const z = res.zones.find((x) => Math.abs(x.price - 60) < 0.01);
  assert.ok(z);
  assert.equal(z.broken, true);
  assert.equal(z.status, "Above price");
  assert.ok(res.broken.includes(z));
  assert.ok(!res.supports.includes(z));
  assert.ok(res.above.includes(z));
  assert.equal(z.id, "A1");
  // the break is dated to the first close clearly below the zone: 55 on bar 13
  assert.equal(z.brokeDate, d.dates[13]);
});

test("levels above price: strongest topAbove kept, listed nearest the price first", () => {
  // five separate dips at 90, 85, 80, 75, 70, then the price falls to 50
  const path = [100, 99, 98];
  for (const b of [90, 85, 80, 75, 70]) path.push(b, 98, 99, 100);
  for (let i = 0; i < 6; i++) path.push(60 - i * 2);
  const res = SR.analyze(synth(path), { window: 252, topAbove: 3 });
  assert.equal(res.supports.length, 0);
  assert.equal(res.broken.length, 5);
  assert.equal(res.above.length, 3);
  assert.deepEqual(res.above.map((z) => z.id), ["A1", "A2", "A3"]);
  for (let k = 1; k < res.above.length; k++) assert.ok(res.above[k].price > res.above[k - 1].price);
  assert.ok(res.above.every((z) => z.distancePct > 0 && z.status === "Above price"));
  // the 1-month style case: no floor below, so the findings and bottom line must name the level above
  const lab = SR.labels({ ...synth(path), ...fakeIndicators(path.length) }, res);
  const items = SR.findings({ ...synth(path), ...fakeIndicators(path.length) }, res, lab);
  assert.ok(items.some((x) => /nearest level above the price is A1/.test(x.html)));
  const bl = SR.bottomLine({ ...synth(path), ...fakeIndicators(path.length) }, res, lab);
  assert.ok(/nearest level is above the price/.test(bl.headline));
  assert.ok(bl.rows.some((r) => r.label === "Above the price"));
});

test("snapshot keeps every level above price, with its A label", () => {
  const path = [100, 99, 98];
  for (const b of [90, 85, 80, 75, 70, 65, 62]) path.push(b, 98, 99, 100);
  for (let i = 0; i < 6; i++) path.push(55 - i * 2);
  const data = { ...synth(path), ...fakeIndicators(path.length) };
  const snap = SR.snapshot(data, { window: 252 });
  assert.equal(snap.broken.length, 7); // the old snapshot kept only 5
  assert.deepEqual(snap.broken.slice(0, 5).map((z) => z.id), ["A1", "A2", "A3", "A4", "A5"]);
  assert.ok(snap.broken.slice(5).every((z) => z.id === null));
});

test("status tells apart in-play, recently tested and holding zones", () => {
  // dip to 50, recover, then drift sideways well above it
  const path = [80, 79, 78, 50, 78, 79, 80];
  for (let i = 0; i < 40; i++) path.push(75);
  const res = SR.analyze(synth(path), { window: 252 });
  const z = res.supports.find((x) => Math.abs(x.price - 50) < 1);
  assert.equal(z.status, "Holding");
  // price coming to rest back inside the zone it bounced from
  const near = SR.analyze(synth([80, 79, 78, 50, 51, 52, 53, 52, 51, 49.9]), { window: 252 });
  assert.ok(near.supports.some((x) => x.status === "In play"));
});

test("minTouches filters single-touch zones", () => {
  const d = synth([70, 69, 68, 60, 68, 69, 70, 71, 72, 73, 74]);
  assert.ok(SR.analyze(d, { minTouches: 1 }).zones.length > 0);
  assert.equal(SR.analyze(d, { minTouches: 2 }).zones.length, 0);
});

test("findings still reach ten items when the window has almost no structure", () => {
  // straight up: no confirmed swing lows at all, so the support findings fall back
  const d = synth(Array.from({ length: 40 }, (_, i) => 50 + i));
  Object.assign(d, {
    rsi14: Array(40).fill(65), macd: Array(40).fill(1), macd_signal: Array(40).fill(0.5),
    macd_hist: Array(40).fill(0.5), bb_upper: Array(40).fill(95), bb_lower: Array(40).fill(80),
    vol_avg20: Array(40).fill(1000), drawdown: Array(40).fill(-2),
    sma20: Array(40).fill(85), qqq_close: Array.from({ length: 40 }, (_, i) => 100 + i / 3),
  });
  const res = SR.analyze(d, { window: 21 });
  const items = SR.findings(d, res, SR.labels(d, res), null, null, {});
  assert.ok(items.length >= 10, `got ${items.length}`);
  assert.ok(items.some((x) => /No confirmed support/.test(x.html)));
  assert.ok(!items.some((x) => /undefined|NaN/.test(x.html)));
});

test("thin windows return fallback levels", () => {
  const d = synth(Array.from({ length: 30 }, (_, i) => 50 + i)); // straight up: no swing lows
  const res = SR.analyze(d, { window: 21 });
  assert.equal(res.supports.length, 0);
  assert.ok(res.fallbacks.length >= 1);
});

test("window limits which pivots are used", () => {
  const lows = [];
  for (let i = 0; i < 300; i++) lows.push(100 + 10 * Math.sin(i / 6));
  const d = synth(lows);
  const long = SR.analyze(d, { window: 252 });
  const short = SR.analyze(d, { window: 21 });
  assert.ok(long.pivots.lows.length > short.pivots.lows.length);
  assert.ok(short.pivots.lows.every((i) => i >= 300 - 21));
});

// The Mondays view is display only — levels always stay on daily data.
test("Mondays view samples each week's Monday session exactly", () => {
  const file = FIXTURE;
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  const res = SR.analyze(d, {});
  const wk = SR.chartModel(d, res, "weekly");

  assert.ok(wk.weekly && wk.dates.length > 0);
  assert.ok(wk.dates.length < d.dates.length / 4, "far fewer bars than days");
  assert.equal(new Set(wk.dates).size, wk.dates.length, "no week drawn twice");

  const dayOf = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
  const byWeek = new Map();
  d.dates.forEach((iso, i) => {
    const k = SR.weekStart(iso);
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(i);
  });

  assert.equal(wk.dates.length, byWeek.size, "exactly one bar per week");
  wk.dates.forEach((iso, w) => {
    const i = d.dates.indexOf(iso);
    assert.ok(i >= 0, `${iso} is a real session`);
    // every value is that one session's, untouched — this is a sample, not a summary
    for (const k of ["open", "high", "low", "close", "volume", "sma20", "sma50", "sma200", "rsi14", "drawdown"]) {
      assert.equal(wk.data[k][w], d[k][i], `${k} on ${iso} is the source session's`);
    }
    // Monday, or the week's first session when Monday was a holiday
    const idx = byWeek.get(SR.weekStart(iso));
    assert.ok(dayOf(iso) === 1 || i === idx[0], `${iso} is a Monday or its week's first session`);
  });
  // holidays are the only reason a bar is not a Monday
  const nonMonday = wk.dates.filter((iso) => dayOf(iso) !== 1);
  assert.ok(nonMonday.length < wk.dates.length * 0.2, "most bars are Mondays");
  for (const iso of nonMonday) {
    assert.ok(!d.dates.includes(SR.weekStart(iso)), `${iso} stands in for a Monday with no session`);
  }
});

test("Mondays view maps swing lows onto the week that contained them", () => {
  const file = FIXTURE;
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  const res = SR.analyze(d, {});
  const wk = SR.chartModel(d, res, "weekly");
  for (const i of res.pivots.lows) {
    const w = wk.dates.findIndex((iso) => SR.weekStart(iso) === SR.weekStart(d.dates[i]));
    assert.ok(wk.lows.includes(w), "each swing low has a week");
  }
  assert.ok(wk.lows.length <= res.pivots.lows.length, "weeks collapse, never multiply");
  assert.ok(wk.used.every((i) => wk.lows.includes(i)), "highlighted bars are a subset of swing-low bars");
  assert.ok(wk.start >= 0 && wk.start < wk.dates.length);
  assert.equal(wk.rollingLow.length, wk.dates.length);
});

test("chartModel leaves the daily view untouched", () => {
  const file = FIXTURE;
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  const res = SR.analyze(d, {});
  const dy = SR.chartModel(d, res, "daily");
  assert.equal(dy.weekly, false);
  assert.equal(dy.data, d);
  assert.equal(dy.start, res.start);
  assert.deepEqual(dy.lows, res.pivots.lows);
});

// freshness drives what the page says about its own data. `nowNY` carries New York
// wall-clock time in its local fields, which is how app.js builds it.
const ny = (s) => new Date(s);

test("freshness: nothing newer to publish reads as current", () => {
  // Tuesday morning, Monday's close published — today has not closed yet
  assert.equal(SR.freshness("2026-09-21", ny("2026-09-22T10:00")).state, "current");
  // Tuesday night, Tuesday's close published
  assert.equal(SR.freshness("2026-09-22", ny("2026-09-22T22:00")).state, "current");
  // over a weekend Friday's close is still the newest there is
  assert.equal(SR.freshness("2026-09-18", ny("2026-09-19T12:00")).state, "current");
  assert.equal(SR.freshness("2026-09-18", ny("2026-09-20T12:00")).state, "current");
  assert.equal(SR.freshness("2026-09-18", ny("2026-09-21T09:00")).state, "current");
});

test("freshness: after the close but before the refresh reads as pending", () => {
  const f = SR.freshness("2026-09-21", ny("2026-09-22T17:05"));
  assert.equal(f.state, "pending");
  assert.equal(f.behind, 1);
  assert.equal(f.expected, "2026-09-22");
  assert.equal(f.expectedIsToday, true);
  // 16:00 is the boundary: at 15:59 today has not closed, at 16:00 it has
  assert.equal(SR.freshness("2026-09-21", ny("2026-09-22T15:59")).state, "current");
  assert.equal(SR.freshness("2026-09-21", ny("2026-09-22T16:00")).state, "pending");
});

test("freshness: a missed session is pending, not silently current", () => {
  // Wednesday morning with Monday's data — Tuesday's run did not publish
  const f = SR.freshness("2026-09-21", ny("2026-09-23T10:00"));
  assert.equal(f.state, "pending");
  assert.equal(f.expected, "2026-09-22");
  assert.equal(f.expectedIsToday, false);
});

test("freshness: several sessions behind is stale", () => {
  const f = SR.freshness("2026-09-18", ny("2026-09-24T17:00"));
  assert.equal(f.state, "stale");
  assert.ok(f.behind >= 3);
});

test("sessionsBetween skips weekends", () => {
  const d = (s) => { const [y, m, x] = s.split("-").map(Number); return new Date(y, m - 1, x); };
  assert.equal(SR.sessionsBetween(d("2026-09-21"), d("2026-09-21")), 0);
  assert.equal(SR.sessionsBetween(d("2026-09-21"), d("2026-09-22")), 1);
  assert.equal(SR.sessionsBetween(d("2026-09-18"), d("2026-09-20")), 0); // weekend only
  assert.equal(SR.sessionsBetween(d("2026-09-18"), d("2026-09-21")), 1);
});

test("bottomLine leads with a headline and stays short", () => {
  const file = FIXTURE;
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  for (const w of Object.values(SR.WINDOW_PRESETS)) {
    const res = SR.analyze(d, { window: w });
    const bl = SR.bottomLine(d, res, SR.labels(d, res));
    assert.ok(bl.headline && bl.headline.length < 220, "headline is one sentence");
    // the summary must stay a summary: far shorter than the full findings list
    assert.ok(bl.rows.length >= 3 && bl.rows.length <= 6, `got ${bl.rows.length} rows`);
    assert.ok(bl.rows.every((r) => r.label && r.html));
    const all = [bl.headline, ...bl.rows.map((r) => r.html)].join(" ");
    assert.ok(!/undefined|NaN/.test(all));
    assert.deepEqual(bl.rows.map((r) => r.label).slice(-3), ["Trend", "Buyers vs sellers", "Risk"]);
  }
});

test("bottomLine names no indicator a layman would have to look up", () => {
  const file = FIXTURE;
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  // terms that need a definition before they mean anything. They are fine further
  // down the page, where there is room to explain them; the summary must not need one.
  const jargon = /\b(RSI|MACD|Bollinger|ATR|swing low|moving average|\d+-day (average|range)|overbought|oversold|momentum|beta|drawdown|volatility)\b/i;
  for (const w of Object.values(SR.WINDOW_PRESETS)) {
    const res = SR.analyze(d, { window: w });
    const bl = SR.bottomLine(d, res, SR.labels(d, res));
    const text = [bl.headline, ...bl.rows.map((r) => r.html), ...bl.rows.map((r) => r.label)].join(" ");
    const hit = text.match(jargon);
    assert.equal(hit, null, `bottom line uses "${hit && hit[0]}" for window ${w}`);
  }
});

test("bottomLine says so plainly when there is no floor to report", () => {
  const d = synth(Array.from({ length: 40 }, (_, i) => 50 + i)); // straight up: no swing lows
  Object.assign(d, {
    rsi14: Array(40).fill(65), macd: Array(40).fill(1), macd_signal: Array(40).fill(0.5),
    macd_hist: Array(40).fill(0.5), bb_upper: Array(40).fill(95), bb_lower: Array(40).fill(80),
    vol_avg20: Array(40).fill(1000), drawdown: Array(40).fill(-2), sma20: Array(40).fill(85),
  });
  const res = SR.analyze(d, { window: 21 });
  const bl = SR.bottomLine(d, res, SR.labels(d, res));
  assert.match(bl.headline, /No floor has formed below it/);
  assert.ok(!/undefined|NaN/.test(bl.headline + bl.rows.map((r) => r.html).join(" ")));
});

test("Bollinger label distinguishes closing through a band from nearing one", () => {
  const file = FIXTURE;
  const base = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  const i = base.close.length - 1;
  const lo = base.bb_lower[i], hi = base.bb_upper[i];
  const at = (close) => {
    const d = { ...base, close: base.close.slice() };
    d.close[i] = close;
    return SR.labels(d, SR.analyze(d, {})).bollinger;
  };
  assert.equal(at(hi + 1).label, "Above upper band");
  assert.equal(at(lo - 1).label, "Below lower band");
  assert.equal(at(lo + (hi - lo) * 0.9).label, "Near upper band");
  assert.equal(at(lo + (hi - lo) * 0.1).label, "Near lower band");
  assert.equal(at(lo + (hi - lo) * 0.5).label, "Mid-range");
  // a close past the band must not be described as merely hugging it
  const res = SR.analyze(base, {});
  const d = { ...base, close: base.close.slice() };
  d.close[i] = hi + 1;
  const txt = SR.findings(d, SR.analyze(d, {}), SR.labels(d, SR.analyze(d, {})), null, null, {})
    .map((x) => x.html).join(" ");
  assert.ok(/above its upper Bollinger Band/.test(txt));
  assert.ok(!/hugging the upper/.test(txt));
  void res;
});

test("diffSnapshots reports new, broken and trend changes", () => {
  const prev = { trend: "Uptrend", rsi_label: "Neutral", macd: "Bullish", ma_cross: null,
    supports: [{ price: 50, touches: 2 }], broken: [] };
  const cur = { trend: "Mixed", rsi_label: "Neutral", macd: "Bearish", ma_cross: null, rsi: 45,
    supports: [{ price: 40, touches: 1 }], broken: [{ price: 50.2, touches: 2 }] };
  const types = SR.diffSnapshots(prev, cur).map((x) => x.type);
  assert.ok(types.includes("new"));
  assert.ok(types.includes("broken"));
  assert.ok(types.includes("trend"));
  assert.ok(types.includes("macd"));
});

test("diffSnapshots reports a level being reclaimed", () => {
  const prev = { trend: "Mixed", rsi_label: "Neutral", macd: "Bearish", ma_cross: null,
    supports: [], broken: [{ price: 60, touches: 3 }] };
  const cur = { trend: "Mixed", rsi_label: "Neutral", macd: "Bearish", ma_cross: null, rsi: 50,
    supports: [{ price: 60.3, touches: 3 }], broken: [] };
  const items = SR.diffSnapshots(prev, cur);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "reclaimed");
});

test("diffSnapshots: with every level kept, a level coming or going is not called a top-5 move", () => {
  const base = { trend: "Mixed", rsi_label: "Neutral", macd: "Bearish", ma_cross: null, rsi: 50, broken: [] };
  const prev = { ...base, supports: [{ price: 50, touches: 2 }] };
  const cur = { ...base, as_of: "2026-10-23", settings: { top: "all" }, supports: [{ price: 40, touches: 3, last_test: "2026-09-01" }] };
  assert.deepEqual(SR.diffSnapshots(prev, cur).map((x) => x.text), [
    "Support at $40.00 (3 touches) is now on the list of levels.",
    "Support at $50.00 is no longer on the list of levels.",
  ]);
  const top5 = { ...cur, settings: { top: 5 } }; // older snapshots kept the strongest five
  assert.match(SR.diffSnapshots(prev, top5)[0].text, /moved into the top 1/);
});

test("the nightly snapshot keeps the levels the page opens on, for every ticker", () => {
  for (const s of ["tqqq", "qqq", "spy"]) {
    const d = SR.fromPayload(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", `${s}-2026-10-23.json`), "utf8")));
    const page = SR.analyze(d, { window: SR.WINDOW_PRESETS["1m"], minLookback: SR.LEVEL_SESSIONS, topN: Infinity, topAbove: Infinity });
    const snap = SR.snapshot(d, SR.PAGE_SETTINGS);
    assert.deepEqual(snap.supports.map((z) => z.price), page.supports.map((z) => +z.price.toFixed(2)), s);
    assert.deepEqual(snap.broken.map((z) => z.price), page.broken.map((z) => +z.price.toFixed(2)), s);
    assert.deepEqual({ levels_from: snap.settings.levels_from, top: snap.settings.top }, { levels_from: 200, top: "all" }, s);
  }
});

test("real TQQQ fixture: sane output for every preset window", () => {
  const file = FIXTURE;
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  for (const w of Object.values(SR.WINDOW_PRESETS)) {
    const res = SR.analyze(d, { window: w });
    assert.ok(res.supports.length <= 5);
    for (const z of res.zones) {
      assert.ok(z.low <= z.price + 1e-9 && z.price <= z.high + 1e-9, "price inside band");
      assert.ok(z.score >= 0 && z.score <= 100);
      assert.ok(["Holding", "Recently tested", "In play", "Above price"].includes(z.status));
      assert.ok(["Strong", "Moderate", "Weak"].includes(z.strength));
    }
    // every level the report shows is a floor: no zone sits clearly above the last close
    assert.ok(res.supports.every((z) => z.low - res.tol / 2 <= res.price));
    assert.ok(res.broken.every((z) => z.status === "Above price"));
    // levels above price really are above it, are at most topAbove, and run nearest first
    assert.ok(res.above.length <= SR.DEFAULTS.topAbove);
    assert.ok(res.above.every((z) => res.broken.includes(z) && z.low - res.tol / 2 > res.price));
    for (let k = 1; k < res.above.length; k++) assert.ok(res.above[k].price > res.above[k - 1].price);
    const lab = SR.labels(d, res);
    assert.ok(["Uptrend", "Downtrend", "Mixed"].includes(lab.trend.label));
    // the report promises at least ten findings, in four known groups
    const runs = SR.compareWindows(d, { window: w });
    const items = SR.findings(d, res, lab, null, null, { runs });
    assert.ok(items.length >= 10, `expected 10+ findings for window ${w}, got ${items.length}`);
    assert.ok(items.every((x) => x.html && x.group));
    assert.deepEqual([...new Set(items.map((x) => x.group))],
      ["Support levels", "Trend", "Momentum & volatility", "Risk & leverage"]);
    assert.ok(!items.some((x) => /undefined|NaN|\$NaN|touchs/.test(x.html)), "no broken interpolation");
  }
  const snap = SR.snapshot(d, {});
  assert.equal(snap.resistances, undefined);
  assert.ok(Array.isArray(snap.supports) && Array.isArray(snap.broken));
  assert.deepEqual(SR.diffSnapshots(snap, snap), []);
  const b = SR.benchmark(d, SR.analyze(d, {}));
  assert.ok(b.beta > 2.5 && b.beta < 3.5, `beta ~3, got ${b.beta}`);
});

test("minLookback: levels come from at least that many sessions, the window stays as chosen", () => {
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(FIXTURE, "utf8")));
  const n = d.close.length;
  const levels = (r) => r.zones.map((z) => [z.price.toFixed(4), z.touches, z.score, z.broken].join(":"));
  const short = SR.analyze(d, { window: 21, minLookback: 200 });
  const long = SR.analyze(d, { window: 200 });
  assert.deepEqual(levels(short), levels(long)); // same levels as a 200-session window
  assert.equal(short.start, n - 21);              // but the window itself is still 21 sessions
  assert.equal(short.levelStart, n - 200);
  // a window longer than the minimum is used as it is
  const year = SR.analyze(d, { window: 252, minLookback: 200 });
  assert.equal(year.levelStart, year.start);
  assert.deepEqual(levels(year), levels(SR.analyze(d, { window: 252 })));
  // without it, nothing changes: levels and window are the same length
  assert.equal(SR.analyze(d, { window: 21 }).levelStart, n - 21);
});

test("tickerInfo: a file's own name, benchmark and leverage; an older file is TQQQ's", () => {
  const old = SR.fromPayload(JSON.parse(fs.readFileSync(FIXTURE, "utf8"))); // written before the multi-ticker change
  expect3(SR.tickerInfo(old), { symbol: "TQQQ", benchmark: "QQQ", leverage: 3, index: "Nasdaq-100" });
  assert.ok(old.bench_close && old.bench_close === old.qqq_close, "the old benchmark series is read as bench_close");
  const qqq = SR.fromPayload(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "qqq-2026-10-23.json"), "utf8")));
  expect3(SR.tickerInfo(qqq), { symbol: "QQQ", benchmark: "SPY", leverage: 1, index: "Nasdaq-100" });
});

function expect3(got, want) { for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, k); }

test("findings and the bottom line use the ticker's name, and leverage wording only for leveraged funds", () => {
  for (const [file, sym, bench, leveraged] of [["tqqq-2026-10-23.json", "TQQQ", "QQQ", true], ["qqq-2026-10-23.json", "QQQ", "SPY", false], ["spy-2026-10-23.json", "SPY", "QQQ", false]]) {
    const d = SR.fromPayload(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", file), "utf8")));
    const res = SR.analyze(d, { window: 252 });
    const lab = SR.labels(d, res);
    const bl = SR.bottomLine(d, res, lab);
    const text = [bl.headline, ...bl.rows.map((r) => r.html), ...SR.findings(d, res, lab).map((x) => x.html)].join(" ");
    assert.ok(text.includes(`${sym} closed at`), `${sym}: headline names the ticker`);
    assert.ok(text.includes(`for ${bench}.`) && text.includes(`Daily beta to ${bench}`), `${sym}: benchmark named`);
    if (sym !== "TQQQ") assert.ok(!/\bTQQQ\b/.test(text), `${sym}: no mention of TQQQ`);
    assert.equal(/three times as much|daily resetting/.test(text), leveraged, `${sym}: leverage wording ${leveraged ? "present" : "absent"}`);
    const b = SR.benchmark(d, res);
    assert.equal(b.leverage, leveraged ? 3 : 1);
    assert.ok(Math.abs(b.naiveLev - b.benchReturn * b.leverage) < 1e-9);
  }
});

test("a zone made of one swing low is written as one price, not a range", () => {
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "qqq-2026-10-23.json"), "utf8")));
  const res = SR.analyze(d, { window: 21, minLookback: 200 });
  assert.ok(res.supports[0].high - res.supports[0].low < 0.005, "QQQ's S1 on 2026-10-23 is a single low");
  const lab = SR.labels(d, res);
  const text = [SR.bottomLine(d, res, lab).headline, ...SR.bottomLine(d, res, lab).rows.map((r) => r.html), ...SR.findings(d, res, lab).map((x) => x.html)].join(" ");
  assert.ok(!/\$(\d+\.\d\d)–\$\1\b/.test(text), "no range from a price to the same price");
  assert.ok(text.includes("$707.23"));
});

/* ------------------------------------------------------------ covered calls */
// prices and option prices from the Oct 30, 2026 close, as the nightly job wrote them
const CC = (() => {
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tqqq-2026-10-30.json"), "utf8")));
  const options = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "options-tqqq-2026-10-30.json"), "utf8"));
  return { d, options, res: SR.analyze(d, SR.PAGE_SETTINGS) };
})();
const ccRow = (cc, date, strike) => cc.groups.find((g) => g.date === date).rows.find((r) => r.strike === strike);

test("the normal distribution and the chance of ending above a strike match values worked out by hand", () => {
  assert.ok(Math.abs(SR.normCdf(0) - 0.5) < 1.5e-7); // the approximation is good to 1.5e-7
  assert.ok(Math.abs(SR.normCdf(1) - 0.841345) < 1e-6);
  assert.ok(Math.abs(SR.normCdf(-1.96) - 0.024998) < 1e-6);
  // at the money with no time value left over: just under 50% (the -σ²T/2 term)
  // σ√T = 0.5 × √(365/365) = 0.5, d2 = -0.25, N(-0.25) = 40.13%
  assert.ok(Math.abs(SR.chanceAbove(100, 100, 0.5, 365) - 40.129) < 1e-3);
  assert.equal(SR.chanceAbove(100, 110, null, 30), null);
  assert.equal(SR.chanceAbove(100, 110, 0.5, 0), null);
});

test("the covered calls on Oct 30 reproduce the plan's worked example", () => {
  const cc = SR.coveredCalls(CC.options, CC.d, CC.res);
  assert.equal(cc.state, "ok");
  assert.deepEqual(cc.levels.map((l) => [l.id, +l.price.toFixed(2)]), [["A1", 66.59], ["A2", 70.26], ["A3", 75.47]]);
  assert.deepEqual([cc.floor.id, +cc.floor.price.toFixed(2)], ["S1", 57.48]);
  // docs/covered-calls-plan.md, section 1: expiry, strike, premium %, per year %, rise %, typical days,
  // chance %, breakeven, return if called %
  const plan = [
    ["2026-11-06", 67, 1.6, 85, 8.0, 1.3, 23, 61.00, 9.7], ["2026-11-06", 70.5, 0.4, 23, 13.7, 2.2, 12, 61.74, 14.1],
    ["2026-11-13", 67, 2.4, 63, 8.0, 1.3, 27, 60.51, 10.5], ["2026-11-13", 71, 0.4, 11, 14.5, 2.4, 14, 61.76, 14.9],
    ["2026-11-20", 67, 3.5, 61, 8.0, 1.3, 30, 59.85, 11.5], ["2026-11-20", 70.5, 2.0, 35, 13.7, 2.2, 20, 60.76, 15.7],
    ["2026-11-20", 75.5, 0.8, 14, 21.8, 3.5, 9, 61.52, 22.5],
  ];
  for (const [date, strike, prem, year, rise, days, chance, be, called] of plan) {
    const r = ccRow(cc, date, strike);
    assert.ok(r, `${date} $${strike} is suggested`);
    assert.deepEqual([+r.premiumPct.toFixed(1), Math.round(r.perYearPct), +r.risePct.toFixed(1), +r.riseAtr.toFixed(1),
      Math.round(r.chance), +r.breakeven.toFixed(2), +r.ifCalledPct.toFixed(1)], [prem, year, rise, days, chance, be, called], `${date} $${strike}`);
  }
  // the premium is the bid, not the last trade or the middle
  assert.equal(ccRow(cc, "2026-11-20", 67).bid, 2.16);
});

test("strikes: the first at or above each level, then by chance; never below the close", () => {
  const cc = SR.coveredCalls(CC.options, CC.d, CC.res);
  const nov20 = cc.groups.find((g) => g.date === "2026-11-20");
  const why = (r) => r.why.map((w) => (w.kind === "level" ? w.id : `${w.target}%`)).join(",");
  assert.deepEqual(nov20.rows.map((r) => [r.strike, why(r)]), [[67, "A1,30%"], [70, "20%"], [70.5, "A2"], [75.5, "A3"]]);
  for (const g of cc.groups) for (const r of g.rows) assert.ok(r.strike >= cc.close, `${g.date} $${r.strike}`);
  // with no level above the price, the strikes by chance are still there
  const none = SR.coveredCalls(CC.options, CC.d, { ...CC.res, above: [] });
  assert.ok(none.groups.every((g) => g.rows.length >= 1 && g.rows.every((r) => r.why.every((w) => w.kind === "chance"))));
  // a level beyond the recorded strikes (the file keeps up to +40%) is named, not dropped
  const far = SR.coveredCalls(CC.options, CC.d, { ...CC.res, above: [...CC.res.above, { id: "A4", price: 95 }] });
  assert.deepEqual(far.unpriced, [{ id: "A4", price: 95 }]);
});

test("thin calls: the temporary limits mark the wide quotes and not the normal ones", () => {
  const cc = SR.coveredCalls(CC.options, CC.d, CC.res);
  // $0.25 bid / $1.20 ask: the case the plan named
  assert.match(ccRow(cc, "2026-11-13", 71).thinWhy.join(), /131% of the middle price/);
  assert.equal(ccRow(cc, "2026-11-06", 67).thin, false); // $1.01 / $1.20
  assert.match(ccRow(cc, "2026-11-20", 70.5).thinWhy.join(), /open interest is 64/);
  // thin calls stay in strike order, marked
  for (const g of cc.groups) assert.deepEqual(g.rows.map((r) => r.strike), [...g.rows.map((r) => r.strike)].sort((a, b) => a - b), g.date);
  // a call with no bid is thin and pays nothing
  const f = SR.callFigures({ strike: 72.5, bid: 0, ask: 0.33, open_interest: 1108, iv: 0.7 }, 62.01, 7, 3.82);
  assert.deepEqual([f.thin, f.thinWhy, f.premiumPct], [true, ["no bid"], 0]);
  // replayed against the whole recorded night: how many TQQQ calls up to +25% the rule marks
  const marked = CC.options.expiries.flatMap((e) => e.calls.filter((c) => c.strike <= 62.01 * 1.25)
    .map((c) => SR.callFigures(c, 62.01, e.days, 3.82).thin));
  assert.equal(marked.length, 90);
  assert.ok(marked.filter(Boolean).length < marked.length / 2, `${marked.filter(Boolean).length} of 90 marked thin`);
});

test("the option prices must be from the report's close", () => {
  assert.equal(SR.coveredCalls(null, CC.d, CC.res).state, "none");
  const other = SR.coveredCalls({ ...CC.options, meta: { ...CC.options.meta, as_of: "2026-10-29" } }, CC.d, CC.res);
  assert.deepEqual(other, { state: "other-close", optionsAsOf: "2026-10-29", asOf: "2026-10-30" });
});

test("a damaged options file gives no row built from it", () => {
  const bad = JSON.parse(JSON.stringify(CC.options));
  bad.meta.fetched_utc = "<img src=x>";
  bad.expiries[0].date = "<b>soon</b>";
  bad.expiries[1].calls[0] = { strike: "<script>", bid: "1", ask: 2 };
  const cc = SR.coveredCalls(bad, CC.d, CC.res);
  assert.equal(cc.fetchedUtc, null);
  assert.ok(!cc.groups.some((g) => g.date.includes("<")));
  for (const g of cc.groups) for (const r of g.rows) assert.equal(typeof r.strike, "number");
});

test("each covered call reads as a sentence", () => {
  const cc = SR.coveredCalls(CC.options, CC.d, CC.res);
  const fmt = (v) => "$" + v.toFixed(2);
  const fmtDate = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const g = cc.groups.find((x) => x.date === "2026-11-20");
  assert.equal(SR.callSentence(ccRow(cc, "2026-11-20", 67), g, cc, "TQQQ", fmt, fmtDate),
    "Sell the Nov 20 $67 call for about $2.16 a share (3.5%). If TQQQ is above $67 on Nov 20, about a 30% chance by the option's own price, "
    + "the shares are sold at $67: a gain of 11.5% including the premium, and nothing above that. "
    + "If it falls, the premium covers only the first $2.16; the nearest floor, S1 at $57.48, is 7.3% below the close.");
  assert.match(SR.callSentence(ccRow(cc, "2026-11-13", 71), cc.groups[1], cc, "TQQQ", fmt, fmtDate),
    /Marked thin: the gap between bid and ask is 131% of the middle price\. The bid shown may not be there when you sell\.$/);
});
