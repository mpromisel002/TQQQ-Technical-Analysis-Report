/*
 * TQQQ support & resistance method — the single implementation used by the page,
 * the daily snapshot job (Node) and the unit tests.
 *
 * Steps (see the Method panel on the page):
 *   1. Swing lows / highs confirmed by `period` sessions on each side (default 3).
 *   2. Rolling `period`-session low (step line).
 *   3. Cluster pivots within clusterMult × ATR(14) into zones (volume-weighted price).
 *   4. Score zones: touches 40%, recency 30%, volume 20%, bounce 10%.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SR = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = { window: 252, period: 3, clusterMult: 0.5, minTouches: 1, topN: 5, bounceLookahead: 10 };
  const LIMITS = {
    window: [21, 252], period: [2, 10], clusterMult: [0.25, 1.5], minTouches: [1, 5],
  };
  const WINDOW_PRESETS = { "1m": 21, "3m": 63, "6m": 126, "9m": 189, "12m": 252 };
  const WEIGHTS = { touches: 0.4, recency: 0.3, volume: 0.2, bounce: 0.1 };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const last = (a) => a[a.length - 1];
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

  /** Normalise user settings into valid ranges. `window` may be "6m" or a number of sessions. */
  function normalize(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    if (typeof o.window === "string") {
      const k = o.window.toLowerCase();
      o.window = WINDOW_PRESETS[k] ?? parseInt(k, 10);
    }
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      let v = Number(o[k]);
      if (!Number.isFinite(v)) v = DEFAULTS[k];
      o[k] = clamp(k === "clusterMult" ? v : Math.round(v), lo, hi);
    }
    return o;
  }

  /**
   * Find swing pivots. kind = "low" | "high".
   * A pivot at i is the extreme of [i-k, i+k]; ties resolve to the earliest bar.
   * Bars in the last k sessions that are the extreme of [i-k, end] are returned as pending.
   */
  function findPivots(values, k, from = 0, kind = "low") {
    const better = kind === "low" ? (a, b) => a < b : (a, b) => a > b;
    const n = values.length;
    const confirmed = [], pending = [];
    for (let i = Math.max(from, k); i < n; i++) {
      const v = values[i];
      if (v == null) continue;
      let ok = true;
      for (let j = i - k; j < i && ok; j++) if (!better(v, values[j])) ok = false; // strictly beyond earlier bars
      const right = Math.min(n - 1, i + k);
      for (let j = i + 1; j <= right && ok; j++) if (better(values[j], v)) ok = false;
      if (!ok) continue;
      (i + k <= n - 1 ? confirmed : pending).push(i);
    }
    return { confirmed, pending };
  }

  /** Lowest low of the last k sessions at every bar (null until k bars exist). */
  function rollingLow(lows, k) {
    return lows.map((_, i) => (i < k - 1 ? null : Math.min(...lows.slice(i - k + 1, i + 1))));
  }

  /** Group pivot indices into zones whose members sit within `tol` of the zone's running price. */
  function cluster(idx, prices, volumes, tol) {
    const pts = idx.map((i) => ({ i, p: prices[i], v: volumes[i] || 1 })).sort((a, b) => a.p - b.p);
    const zones = [];
    let cur = null;
    for (const pt of pts) {
      if (cur && pt.p - cur.price <= tol) {
        cur.members.push(pt);
        const vw = cur.members.reduce((s, m) => s + m.v, 0);
        cur.price = cur.members.reduce((s, m) => s + m.p * m.v, 0) / vw;
      } else {
        cur = { price: pt.p, members: [pt] };
        zones.push(cur);
      }
    }
    return zones;
  }

  /**
   * Core analysis over the selected window.
   * data = { dates, open, high, low, close, volume, atr14, ... } (full history arrays)
   * Returns zones, pivots and helper series restricted to the window.
   */
  function analyze(data, opts) {
    const o = normalize(opts);
    const n = data.close.length;
    const start = Math.max(0, n - o.window);
    const endIdx = n - 1;
    const price = data.close[endIdx];
    const atr = data.atr14[endIdx] ?? mean(data.high.slice(start).map((h, j) => h - data.low[start + j]));
    const tol = o.clusterMult * atr;
    const avgVol = mean(data.volume.slice(start));

    const lowP = findPivots(data.low, o.period, start, "low");
    const highP = findPivots(data.high, o.period, start, "high");

    const build = (idx, kind) => {
      const prices = kind === "low" ? data.low : data.high;
      return cluster(idx, prices, data.volume, tol).map((z) => {
        const members = z.members.sort((a, b) => a.i - b.i);
        const lo = Math.min(...members.map((m) => m.p));
        const hi = Math.max(...members.map((m) => m.p));
        const lastI = last(members).i;
        // bounce: best move away from the pivot within the look-ahead, in % of pivot price
        const bounces = members.map((m) => {
          const end = Math.min(endIdx, m.i + o.bounceLookahead);
          if (end <= m.i) return 0;
          const seg = kind === "low" ? data.high.slice(m.i + 1, end + 1) : data.low.slice(m.i + 1, end + 1);
          const ext = kind === "low" ? Math.max(...seg) : Math.min(...seg);
          return Math.abs(ext - m.p) / m.p * 100;
        });
        // later tests: bars after the last pivot that entered the band (with tolerance) without being pivots
        const bandLo = lo - tol / 2, bandHi = hi + tol / 2;
        let lastTest = lastI, closedThrough = false;
        for (let i = lastI + 1; i <= endIdx; i++) {
          if (data.low[i] <= bandHi && data.high[i] >= bandLo) lastTest = i;
          if (kind === "low" ? data.close[i] < lo - tol / 2 : data.close[i] > hi + tol / 2) closedThrough = true;
        }
        return {
          origin: kind === "low" ? "support" : "resistance",
          price: z.price, low: lo, high: hi,
          touches: members.length,
          pivots: members.map((m) => m.i),
          firstIdx: members[0].i, lastPivotIdx: lastI, lastTestIdx: lastTest,
          avgVolume: mean(members.map((m) => m.v)),
          bounce: mean(bounces),
          closedThrough,
        };
      });
    };

    let zones = [...build(lowP.confirmed, "low"), ...build(highP.confirmed, "high")]
      .filter((z) => z.touches >= o.minTouches);

    // scoring (normalised within this window)
    const maxT = Math.max(1, ...zones.map((z) => z.touches));
    const maxV = Math.max(1, ...zones.map((z) => z.avgVolume / avgVol));
    const maxB = Math.max(1e-9, ...zones.map((z) => z.bounce));
    const span = Math.max(1, endIdx - start);
    for (const z of zones) {
      const c = {
        touches: z.touches / maxT,
        recency: clamp(1 - (endIdx - z.lastTestIdx) / span, 0, 1),
        volume: (z.avgVolume / avgVol) / maxV,
        bounce: z.bounce / maxB,
      };
      z.components = c;
      z.score = Math.round(100 * Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * c[k], 0));
      z.volumeRatio = z.avgVolume / avgVol;
      z.volumeLabel = z.volumeRatio >= 1.3 ? "Heavy" : z.volumeRatio <= 0.8 ? "Light" : "Normal";
      // role relative to the latest close
      // role relative to the latest close: a level flips only when price has closed clearly through it
      const flipped = z.origin === "support" ? price < z.low - tol / 2 : price > z.high + tol / 2;
      z.role = flipped ? (z.origin === "support" ? "resistance" : "support") : z.origin;
      z.distancePct = (z.price / price - 1) * 100;
      z.atPrice = price >= z.low - tol / 2 && price <= z.high + tol / 2;
      if (flipped) z.status = "Broken";           // old support now overhead, or old resistance now below
      else if (z.atPrice || endIdx - z.lastTestIdx <= 10 || z.closedThrough) z.status = "Tested";
      else z.status = "Holding";
      z.date = data.dates[z.lastTestIdx];
      z.firstDate = data.dates[z.firstIdx];
    }

    const pick = (role) => zones.filter((z) => z.role === role)
      .sort((a, b) => b.score - a.score).slice(0, o.topN)
      .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
    const supports = pick("support");
    const resistances = pick("resistance");

    // fallbacks for thin windows
    const rl = rollingLow(data.low, o.period);
    const fallbacks = [];
    if (supports.length < 2) {
      fallbacks.push({ label: `${o.period}-day rolling low`, price: rl[endIdx] });
      if (data.sma50 && data.sma50[endIdx] != null && data.sma50[endIdx] < price)
        fallbacks.push({ label: "50-day average", price: data.sma50[endIdx] });
    }

    return {
      opts: o, start, end: endIdx, price, atr, tol, avgVolume: avgVol,
      zones, supports, resistances, fallbacks,
      pivots: {
        lows: lowP.confirmed, highs: highP.confirmed,
        pendingLows: lowP.pending, pendingHighs: highP.pending,
      },
      rollingLow: rl,
    };
  }

  /* ------------------------------------------------------------------ indicators & labels */
  function crossDate(data, a, b, from) {
    // latest index where series a crossed series b; returns {idx, dir}
    for (let i = data.close.length - 1; i > Math.max(from, 0); i--) {
      const p0 = data[a][i - 1], q0 = data[b][i - 1], p1 = data[a][i], q1 = data[b][i];
      if ([p0, q0, p1, q1].some((v) => v == null)) continue;
      if ((p0 - q0) * (p1 - q1) < 0 || (p0 === q0 && p1 !== q1)) return { idx: i, dir: p1 > q1 ? "up" : "down" };
    }
    return null;
  }

  function trendCall(data, res) {
    const i = res.end, c = data.close[i];
    const s50 = data.sma50[i], s200 = data.sma200[i], s50p = data.sma50[i - 20];
    const lows = res.pivots.lows;
    const checks = {
      averages: s50 == null || s200 == null ? 0 : c > s50 && c > s200 ? 1 : c < s50 && c < s200 ? -1 : 0,
      slope: s50 == null || s50p == null ? 0 : s50 > s50p ? 1 : s50 < s50p ? -1 : 0,
      swings: lows.length < 2 ? 0 : data.low[last(lows)] > data.low[lows[lows.length - 2]] ? 1 : -1,
    };
    const vals = Object.values(checks);
    const label = vals.every((v) => v === 1) ? "Uptrend" : vals.every((v) => v === -1) ? "Downtrend" : "Mixed";
    return { label, checks, slopePct: s50p ? (s50 / s50p - 1) * 100 : null };
  }

  function labels(data, res) {
    const i = res.end;
    const rsi = data.rsi14[i];
    const bbU = data.bb_upper[i], bbL = data.bb_lower[i];
    const c = data.close[i];
    const bbPos = bbU != null ? (c - bbL) / (bbU - bbL) : null;
    const vr = data.volume[i] / data.vol_avg20[i];
    const golden = crossDate(data, "sma50", "sma200", 200);
    const macdX = crossDate(data, "macd", "macd_signal", 35);
    return {
      trend: trendCall(data, res),
      rsi: { value: rsi, label: rsi >= 70 ? "Overbought" : rsi <= 30 ? "Oversold" : "Neutral" },
      macd: {
        value: data.macd[i], signal: data.macd_signal[i], hist: data.macd_hist[i],
        label: data.macd[i] >= data.macd_signal[i] ? "Bullish" : "Bearish",
        crossDate: macdX ? data.dates[macdX.idx] : null, crossDir: macdX?.dir,
      },
      bollinger: {
        position: bbPos,
        label: bbPos == null ? "n/a" : bbPos >= 0.8 ? "Near upper band" : bbPos <= 0.2 ? "Near lower band" : "Mid-range",
      },
      atr: { value: res.atr, pct: (res.atr / c) * 100 },
      volume: { ratio: vr, label: vr >= 1.3 ? "Heavy" : vr <= 0.7 ? "Light" : "Normal" },
      maCross: golden ? { date: data.dates[golden.idx], type: golden.dir === "up" ? "Golden cross" : "Death cross" } : null,
      drawdown: data.drawdown[i],
      high12m: Math.max(...data.high.slice(Math.max(0, data.close.length - 252))),
    };
  }

  /** Daily-return comparison with the benchmark over the window. */
  function benchmark(data, res) {
    const r = [], q = [];
    for (let i = res.start + 1; i <= res.end; i++) {
      r.push(data.close[i] / data.close[i - 1] - 1);
      q.push(data.qqq_close[i] / data.qqq_close[i - 1] - 1);
    }
    const mr = mean(r), mq = mean(q);
    let cov = 0, vq = 0, vr = 0;
    for (let j = 0; j < r.length; j++) {
      cov += (r[j] - mr) * (q[j] - mq); vq += (q[j] - mq) ** 2; vr += (r[j] - mr) ** 2;
    }
    const s = res.start, e = res.end;
    const tqRet = (data.close[e] / data.close[s] - 1) * 100;
    const qqRet = (data.qqq_close[e] / data.qqq_close[s] - 1) * 100;
    return {
      beta: cov / vq, corr: cov / Math.sqrt(vq * vr), tqqqReturn: tqRet, qqqReturn: qqRet,
      naive3x: qqRet * 3, // simple 3× of the period return, to show the daily-reset gap
      volTqqq: Math.sqrt(vr / r.length) * Math.sqrt(252) * 100,
      volQqq: Math.sqrt(vq / q.length) * Math.sqrt(252) * 100,
    };
  }

  /** Volume traded at each price bucket over the window (typical price per bar). */
  function volumeProfile(data, res, bins = 30) {
    const lo = Math.min(...data.low.slice(res.start, res.end + 1));
    const hi = Math.max(...data.high.slice(res.start, res.end + 1));
    const w = (hi - lo) / bins || 1;
    const out = Array.from({ length: bins }, (_, b) => ({ low: lo + b * w, high: lo + (b + 1) * w, volume: 0 }));
    for (let i = res.start; i <= res.end; i++) {
      // spread each bar's volume evenly across the buckets its range covers
      const b0 = clamp(Math.floor((data.low[i] - lo) / w), 0, bins - 1);
      const b1 = clamp(Math.floor((data.high[i] - lo) / w), 0, bins - 1);
      const share = data.volume[i] / (b1 - b0 + 1);
      for (let b = b0; b <= b1; b++) out[b].volume += share;
    }
    return out;
  }

  /** Top levels for several windows, and whether each level recurs across windows. */
  function compareWindows(data, opts, windows = [21, 63, 126, 252]) {
    const base = normalize(opts);
    const runs = windows.map((w) => ({ window: w, res: analyze(data, { ...base, window: w }) }));
    const tol = runs[0].res.tol;
    const all = runs.flatMap((r) => [...r.res.supports, ...r.res.resistances].map((z) => ({ w: r.window, z })));
    for (const a of all) {
      const seen = new Set(all.filter((b) => Math.abs(b.z.price - a.z.price) <= tol).map((b) => b.w));
      a.z.windowsSeen = seen.size;
    }
    return runs;
  }

  /** Plain-language findings (up to 5 sentences) for the current window. */
  function findings(data, res, lab, fmt, fmtDate) {
    const f = fmt || ((v) => "$" + v.toFixed(2));
    const fd = fmtDate || ((d) => d);
    const pct = (v) => Math.abs(v).toFixed(1) + "%";
    const out = [];
    const t = lab.trend;
    const why = {
      Uptrend: "price is above its 50 and 200-day averages, the 50-day is rising, and swing lows are getting higher",
      Downtrend: "price is below its 50 and 200-day averages, the 50-day is falling, and swing lows are getting lower",
      Mixed: "the averages, the 50-day slope and the swing lows disagree",
    }[t.label];
    out.push({ html: `TQQQ is in a${t.label === "Uptrend" ? "n" : ""} <b>${t.label.toLowerCase()}</b>${t.label === "Mixed" ? " trend" : ""}: ${why}.` });

    const s = res.supports[0], r = res.resistances[0];
    if (s) {
      const where = s.atPrice ? `and price is inside it right now (zone midpoint ${pct(s.distancePct)} ${s.distancePct <= 0 ? "below" : "above"} the close)`
        : `${pct(s.distancePct)} below the last close`;
      let txt = `Nearest support is <b>${f(s.low)}–${f(s.high)}</b>, ${where}. ` +
        `It has held ${s.touches} time${s.touches > 1 ? "s" : ""}, most recently on ${fd(s.date)}.`;
      if (r) txt += ` Nearest resistance is ${f(r.low)}–${f(r.high)}, ${r.atPrice ? "with price already inside it" : pct(r.distancePct) + " above"}.`;
      out.push({ html: txt });
    } else if (res.fallbacks.length) {
      out.push({ html: `No confirmed support below price in this window. Fallback levels: ${res.fallbacks.map((x) => `${x.label} ${f(x.price)}`).join(", ")}.` });
    }
    const strongest = [...res.supports].sort((a, b) => b.score - a.score)[0];
    if (strongest) {
      out.push({ html: `The strongest support in this window is <b>${f(strongest.price)}</b> (${strongest.touches} touch${strongest.touches > 1 ? "es" : ""}, ${strongest.volumeLabel.toLowerCase()} volume, score ${strongest.score}).` });
    }
    const rv = lab.rsi.value;
    const rsiTxt = rv >= 70 ? "overbought. Short-term pullbacks are more likely than usual."
      : rv >= 60 ? "close to overbought. Short-term pullbacks are more likely than usual."
      : rv <= 30 ? "oversold. Selling may be stretched and bounces are more likely than usual."
      : rv <= 40 ? "close to oversold; momentum is weak."
      : "neutral.";
    out.push({ html: `RSI is ${rv.toFixed(0)}, ${rsiTxt} MACD is ${lab.macd.label.toLowerCase()}${lab.macd.crossDate ? ` (crossed ${lab.macd.crossDir} on ${fd(lab.macd.crossDate)})` : ""}.` });
    if (s) {
      out.push({ html: `TQQQ usually moves about ${lab.atr.pct.toFixed(1)}% a day. A stop placed 1 ATR below support would be near <b>${f(s.low - res.atr)}</b>.` });
    }
    return out.slice(0, 5);
  }

  /** Compact snapshot used for the daily history files and "what changed". */
  function snapshot(data, opts) {
    const res = analyze(data, opts);
    const lab = labels(data, res);
    const z = (x) => ({
      role: x.role, origin: x.origin, price: +x.price.toFixed(2), low: +x.low.toFixed(2), high: +x.high.toFixed(2),
      touches: x.touches, score: x.score, status: x.status, last_test: x.date,
    });
    return {
      as_of: data.dates[res.end], close: +res.price.toFixed(2),
      settings: { window: res.opts.window, period: res.opts.period, clusterMult: res.opts.clusterMult, minTouches: res.opts.minTouches },
      trend: lab.trend.label, rsi: +lab.rsi.value.toFixed(1), rsi_label: lab.rsi.label,
      macd: lab.macd.label, ma_cross: lab.maCross,
      atr_pct: +lab.atr.pct.toFixed(2), drawdown: +lab.drawdown.toFixed(2),
      supports: res.supports.map(z), resistances: res.resistances.map(z),
    };
  }

  /** Compare two snapshots and describe what changed. */
  function diffSnapshots(prev, cur, tolPct = 1.5) {
    const out = [];
    if (!prev) return out;
    const near = (a, b) => Math.abs(a.price / b.price - 1) * 100 <= tolPct;
    const prevAll = [...prev.supports, ...prev.resistances];
    const curAll = [...cur.supports, ...cur.resistances];
    for (const z of curAll) {
      const m = prevAll.find((p) => near(p, z));
      if (!m) {
        const R = z.role[0].toUpperCase() + z.role.slice(1);
        out.push({ type: "new", text: z.last_test === cur.as_of && z.touches === 1
          ? `New ${z.role} level formed at $${z.price.toFixed(2)}.`
          : `${R} at $${z.price.toFixed(2)} (${z.touches} touch${z.touches > 1 ? "es" : ""}) moved into the top ${Math.max(cur[z.role === "support" ? "supports" : "resistances"].length, 1)}.` });
      }
      else if (m.role !== z.role)
        out.push({ type: z.role === "resistance" ? "broken" : "reclaimed", text: z.role === "resistance"
          ? `Support at $${z.price.toFixed(2)} broke; it is now overhead resistance.`
          : `Price moved above $${z.price.toFixed(2)}; that level now acts as support.` });
    }
    for (const p of prevAll) {
      if (!curAll.find((z) => near(p, z))) out.push({ type: "dropped", text: `${p.role[0].toUpperCase() + p.role.slice(1)} at $${p.price.toFixed(2)} dropped out of the top list.` });
    }
    if (prev.trend !== cur.trend) out.push({ type: "trend", text: `Trend changed from ${prev.trend} to ${cur.trend}.` });
    if (prev.rsi_label !== cur.rsi_label) out.push({ type: "rsi", text: `RSI moved from ${prev.rsi_label.toLowerCase()} to ${cur.rsi_label.toLowerCase()} (${cur.rsi}).` });
    if (prev.macd !== cur.macd) out.push({ type: "macd", text: `MACD turned ${cur.macd.toLowerCase()}.` });
    const pc = prev.ma_cross?.date, cc = cur.ma_cross?.date;
    if (cc && cc !== pc) out.push({ type: "cross", text: `${cur.ma_cross.type} on ${cc}.` });
    return out;
  }

  /** Slice the payload's arrays up to (and including) index `end` — used for backfilling history. */
  function truncate(data, end) {
    const out = { ...data };
    for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) out[k] = v.slice(0, end + 1);
    return out;
  }

  /** Flatten the tqqq.json payload into { dates, open, ..., sma50, ... }. */
  function fromPayload(p) {
    return { dates: p.dates, ...p.series, meta: p.meta };
  }

  return {
    DEFAULTS, LIMITS, WINDOW_PRESETS, WEIGHTS,
    normalize, findPivots, rollingLow, cluster, analyze, labels, trendCall, benchmark,
    volumeProfile, compareWindows, findings, snapshot, diffSnapshots, truncate, fromPayload,
  };
});
