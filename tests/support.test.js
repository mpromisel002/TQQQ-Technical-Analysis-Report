// Unit tests for docs/js/support.js — run with: node --test tests/
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
  assert.ok(res.supports.every((z) => z.price < res.price));
  assert.ok(res.resistances.every((z) => z.price > res.price || z.status === "Tested"));
});

test("a support that price closed below is Broken and becomes resistance", () => {
  const path = [70, 69, 68, 60, 68, 69, 70, 69, 68, 67, 66, 65, 60, 55, 54, 53, 52, 52, 52];
  const d = synth(path);
  const res = SR.analyze(d, { window: 252 });
  const z = res.zones.find((x) => x.origin === "support" && Math.abs(x.price - 60) < 0.01);
  assert.ok(z);
  assert.equal(z.role, "resistance");
  assert.equal(z.status, "Broken");
  assert.ok(res.resistances.includes(z));
});

test("minTouches filters single-touch zones", () => {
  const d = synth([70, 69, 68, 60, 68, 69, 70, 71, 72, 73, 74]);
  assert.ok(SR.analyze(d, { minTouches: 1 }).zones.length > 0);
  assert.equal(SR.analyze(d, { minTouches: 2 }).zones.length, 0);
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

test("diffSnapshots reports new, broken and trend changes", () => {
  const prev = { trend: "Uptrend", rsi_label: "Neutral", macd: "Bullish", ma_cross: null,
    supports: [{ role: "support", price: 50, touches: 2 }], resistances: [] };
  const cur = { trend: "Mixed", rsi_label: "Neutral", macd: "Bearish", ma_cross: null, rsi: 45,
    supports: [{ role: "support", price: 40, touches: 1 }], resistances: [{ role: "resistance", price: 50.2, touches: 2 }] };
  const types = SR.diffSnapshots(prev, cur).map((x) => x.type);
  assert.ok(types.includes("new"));
  assert.ok(types.includes("broken"));
  assert.ok(types.includes("trend"));
  assert.ok(types.includes("macd"));
});

test("real TQQQ fixture: sane output for every preset window", () => {
  const file = path.join(__dirname, "..", "docs", "data", "tqqq.json");
  if (!fs.existsSync(file)) return;
  const d = SR.fromPayload(JSON.parse(fs.readFileSync(file, "utf8")));
  for (const w of Object.values(SR.WINDOW_PRESETS)) {
    const res = SR.analyze(d, { window: w });
    assert.ok(res.supports.length <= 5 && res.resistances.length <= 5);
    for (const z of res.zones) {
      assert.ok(z.low <= z.price + 1e-9 && z.price <= z.high + 1e-9, "price inside band");
      assert.ok(z.score >= 0 && z.score <= 100);
      assert.ok(["Holding", "Tested", "Broken"].includes(z.status));
    }
    const lab = SR.labels(d, res);
    assert.ok(["Uptrend", "Downtrend", "Mixed"].includes(lab.trend.label));
    assert.ok(SR.findings(d, res, lab).length <= 5);
  }
  const b = SR.benchmark(d, SR.analyze(d, {}));
  assert.ok(b.beta > 2.5 && b.beta < 3.5, `beta ~3, got ${b.beta}`);
});
