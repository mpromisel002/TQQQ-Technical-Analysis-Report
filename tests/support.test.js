// Unit tests for docs/js/support.js (support-only method) — run with: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const SR = require("../docs/js/support.js");

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

test("a support that price closed below is Broken and leaves the support list", () => {
  const path = [70, 69, 68, 60, 68, 69, 70, 69, 68, 67, 66, 65, 60, 55, 54, 53, 52, 52, 52];
  const d = synth(path);
  const res = SR.analyze(d, { window: 252 });
  const z = res.zones.find((x) => Math.abs(x.price - 60) < 0.01);
  assert.ok(z);
  assert.equal(z.broken, true);
  assert.equal(z.status, "Broken");
  assert.ok(res.broken.includes(z));
  assert.ok(!res.supports.includes(z));
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
  const file = path.join(__dirname, "..", "docs", "data", "tqqq.json");
  if (!fs.existsSync(file)) return;
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  for (const w of Object.values(SR.WINDOW_PRESETS)) {
    const res = SR.analyze(d, { window: w });
    const bl = SR.bottomLine(d, res, SR.labels(d, res));
    assert.ok(bl.headline && bl.headline.length < 220, "headline is one sentence");
    // the summary must stay a summary: far shorter than the full findings list
    assert.ok(bl.rows.length >= 3 && bl.rows.length <= 5, `got ${bl.rows.length} rows`);
    assert.ok(bl.rows.every((r) => r.label && r.html));
    const all = [bl.headline, ...bl.rows.map((r) => r.html)].join(" ");
    assert.ok(!/undefined|NaN/.test(all));
    assert.deepEqual(bl.rows.map((r) => r.label).slice(-3), ["Trend", "Momentum", "Risk"]);
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
  const file = path.join(__dirname, "..", "docs", "data", "tqqq.json");
  if (!fs.existsSync(file)) return;
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

test("real TQQQ fixture: sane output for every preset window", () => {
  const file = path.join(__dirname, "..", "docs", "data", "tqqq.json");
  if (!fs.existsSync(file)) return;
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  for (const w of Object.values(SR.WINDOW_PRESETS)) {
    const res = SR.analyze(d, { window: w });
    assert.ok(res.supports.length <= 5);
    for (const z of res.zones) {
      assert.ok(z.low <= z.price + 1e-9 && z.price <= z.high + 1e-9, "price inside band");
      assert.ok(z.score >= 0 && z.score <= 100);
      assert.ok(["Holding", "Recently tested", "In play", "Broken"].includes(z.status));
      assert.ok(["Strong", "Moderate", "Weak"].includes(z.strength));
    }
    // every level the report shows is a floor: no zone sits clearly above the last close
    assert.ok(res.supports.every((z) => z.low - res.tol / 2 <= res.price));
    assert.ok(res.broken.every((z) => z.status === "Broken"));
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
