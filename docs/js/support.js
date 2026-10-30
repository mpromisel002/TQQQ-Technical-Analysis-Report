/*
 * Support method — the single implementation used by the page,
 * the daily snapshot job (Node) and the unit tests.
 *
 * Steps (see the Method panel on the page):
 *   1. Swing lows confirmed by `period` sessions on each side (default 3).
 *   2. Rolling `period`-session low (step line).
 *   3. Cluster swing lows within clusterMult × ATR(14) into zones (volume-weighted price).
 *   4. Score zones: touches 40%, recency 30%, volume 20%, bounce 10%.
 *
 * The report covers support only, found from swing lows. Swing highs are not
 * used. Support zones the price has since fallen below are still reported, as
 * "levels above price" (A1, A2, …) next to S1–S5, because a floor that gave way
 * is often where a later rise stalls.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SR = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // minLookback: levels are found over at least this many sessions, even when the window
  // is shorter (the page passes 200). 0 keeps levels and window the same length.
  const DEFAULTS = { window: 252, period: 3, clusterMult: 0.5, minTouches: 1, topN: 5, topAbove: 5, bounceLookahead: 10, minLookback: 0 };
  const LIMITS = {
    window: [21, 252], period: [2, 10], clusterMult: [0.25, 1.5], minTouches: [1, 5],
  };
  const WINDOW_PRESETS = { "1m": 21, "3m": 63, "6m": 126, "9m": 189, "12m": 252 };
  // what the page opens on: every level from at least the last 200 sessions, 1-month window.
  // The nightly snapshot and "What changed" use the same, so they describe the levels on screen.
  const LEVEL_SESSIONS = 200;
  const PAGE_SETTINGS = { window: WINDOW_PRESETS["1m"], minLookback: LEVEL_SESSIONS, topN: Infinity, topAbove: Infinity };
  const WEIGHTS = { touches: 0.4, recency: 0.3, volume: 0.2, bounce: 0.1 };
  // plain-language buckets for the 0-100 strength score
  const TIERS = [[70, "Strong"], [40, "Moderate"], [0, "Weak"]];

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const last = (a) => a[a.length - 1];
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

  /** "Strong" / "Moderate" / "Weak" for a 0-100 strength score. */
  const strengthTier = (score) => TIERS.find(([min]) => score >= min)[1];

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
   * Returns support zones, swing lows and helper series restricted to the window.
   */
  function analyze(data, opts) {
    const o = normalize(opts);
    const n = data.close.length;
    // `start` is the chosen window (chart view, returns, volatility); `ls` is where the
    // search for levels begins, which reaches back at least minLookback sessions
    const start = Math.max(0, n - o.window);
    const ls = Math.max(0, n - Math.max(o.window, o.minLookback || 0));
    const endIdx = n - 1;
    const price = data.close[endIdx];
    const atr = data.atr14[endIdx] ?? mean(data.high.slice(ls).map((h, j) => h - data.low[ls + j]));
    const tol = o.clusterMult * atr;
    const half = tol / 2;
    const avgVol = mean(data.volume.slice(ls));

    const lowP = findPivots(data.low, o.period, ls, "low");

    let zones = cluster(lowP.confirmed, data.low, data.volume, tol).map((z) => {
      const members = z.members.sort((a, b) => a.i - b.i);
      const lo = Math.min(...members.map((m) => m.p));
      const hi = Math.max(...members.map((m) => m.p));
      const lastI = last(members).i;
      // bounce: best move up away from the low within the look-ahead, in % of the low
      const bounces = members.map((m) => {
        const end = Math.min(endIdx, m.i + o.bounceLookahead);
        if (end <= m.i) return 0;
        const ext = Math.max(...data.high.slice(m.i + 1, end + 1));
        return Math.abs(ext - m.p) / m.p * 100;
      });
      // later tests: bars after the last swing low that entered the band (with tolerance)
      const bandLo = lo - half, bandHi = hi + half;
      let lastTest = lastI, brokeBefore = false, brokeIdx = null;
      for (let i = lastI + 1; i <= endIdx; i++) {
        if (data.low[i] <= bandHi && data.high[i] >= bandLo) lastTest = i;
        if (data.close[i] < lo - half) {
          // the latest close that went from inside or above the zone to clearly below it
          if (data.close[i - 1] >= lo - half) brokeIdx = i;
          brokeBefore = true;
        }
      }
      return {
        price: z.price, low: lo, high: hi,
        touches: members.length,
        pivots: members.map((m) => m.i),
        firstIdx: members[0].i, lastPivotIdx: lastI, lastTestIdx: lastTest,
        avgVolume: mean(members.map((m) => m.v)),
        bounce: mean(bounces),
        brokeBefore, brokeIdx,
      };
    }).filter((z) => z.touches >= o.minTouches);

    // scoring (normalised within this window)
    const maxT = Math.max(1, ...zones.map((z) => z.touches));
    const maxV = Math.max(1, ...zones.map((z) => z.avgVolume / avgVol));
    const maxB = Math.max(1e-9, ...zones.map((z) => z.bounce));
    const span = Math.max(1, endIdx - ls); // recency is scored over the whole look-back
    for (const z of zones) {
      const c = {
        touches: z.touches / maxT,
        recency: clamp(1 - (endIdx - z.lastTestIdx) / span, 0, 1),
        volume: (z.avgVolume / avgVol) / maxV,
        bounce: z.bounce / maxB,
      };
      z.components = c;
      z.score = Math.round(100 * Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * c[k], 0));
      z.strength = strengthTier(z.score);
      z.volumeRatio = z.avgVolume / avgVol;
      z.volumeLabel = z.volumeRatio >= 1.3 ? "Heavy" : z.volumeRatio <= 0.8 ? "Light" : "Normal";
      z.distancePct = (z.price / price - 1) * 100;
      // a zone is broken once price closes clearly below it; until then it is live support.
      // A broken zone sits above the price, and is listed as a level above price.
      z.broken = price < z.low - half;
      z.inZone = !z.broken && price <= z.high + half;
      z.status = z.broken ? "Above price"
        : z.inZone ? "In play"
        : endIdx - z.lastTestIdx <= 10 ? "Recently tested" : "Holding";
      z.date = data.dates[z.lastTestIdx];
      z.firstDate = data.dates[z.firstIdx];
      z.brokeDate = z.broken && z.brokeIdx != null ? data.dates[z.brokeIdx] : null;
    }

    // live support: strongest `topN`, then listed nearest-to-price first
    const supports = zones.filter((z) => !z.broken)
      .sort((a, b) => b.score - a.score).slice(0, o.topN)
      .sort((a, b) => b.price - a.price)
      .map((z, i) => Object.assign(z, { rank: i + 1, id: "S" + (i + 1) }));
    // zones price has closed below, nearest first — every one is kept for the "what changed" feed
    const broken = zones.filter((z) => z.broken).sort((a, b) => a.price - b.price);
    // levels above price: chosen the same way as S1–S5 (strongest `topAbove`), listed nearest first
    const above = [...broken].sort((a, b) => b.score - a.score).slice(0, o.topAbove)
      .sort((a, b) => a.price - b.price)
      .map((z, i) => Object.assign(z, { rank: i + 1, id: "A" + (i + 1) }));

    // fallbacks for thin windows
    const rl = rollingLow(data.low, o.period);
    const fallbacks = [];
    if (supports.length < 2) {
      fallbacks.push({ label: `${o.period}-day rolling low`, price: rl[endIdx] });
      if (data.sma50 && data.sma50[endIdx] != null && data.sma50[endIdx] < price)
        fallbacks.push({ label: "50-day average", price: data.sma50[endIdx] });
    }

    return {
      opts: o, start, levelStart: ls, end: endIdx, price, atr, tol, avgVolume: avgVol,
      zones, supports, above, broken, fallbacks,
      // zones found but not listed, because only the strongest topN / topAbove are shown;
      // the page says how many, so no level found is dropped without a word
      unlisted: { below: zones.length - broken.length - supports.length, above: broken.length - above.length },
      pivots: { lows: lowP.confirmed, pendingLows: lowP.pending },
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
        // position is 0 at the lower band and 1 at the upper, so it runs past
        // those bounds when price closes through a band — a different condition
        // from merely approaching one, and labelled as such
        position: bbPos,
        label: bbPos == null ? "n/a"
          : bbPos > 1 ? "Above upper band"
          : bbPos < 0 ? "Below lower band"
          : bbPos >= 0.8 ? "Near upper band"
          : bbPos <= 0.2 ? "Near lower band" : "Mid-range",
      },
      atr: { value: res.atr, pct: (res.atr / c) * 100 },
      volume: { ratio: vr, label: vr >= 1.3 ? "Heavy" : vr <= 0.7 ? "Light" : "Normal" },
      maCross: golden ? { date: data.dates[golden.idx], type: golden.dir === "up" ? "Golden cross" : "Death cross" } : null,
      drawdown: data.drawdown[i],
      high12m: Math.max(...data.high.slice(Math.max(0, data.close.length - 252))),
    };
  }

  /**
   * The ticker's name, benchmark and leverage. Files written before the multi-ticker
   * change carry no such fields and are TQQQ's, so TQQQ's values are the fallback.
   */
  function tickerInfo(data) {
    const m = data.meta || {};
    return { symbol: m.symbol || "TQQQ", benchmark: m.benchmark || "QQQ", leverage: m.leverage ?? 3,
      // null for a ticker added from the page, whose index is not known
      index: m.index !== undefined ? m.index : "Nasdaq-100", name: m.name || "ProShares UltraPro QQQ" };
  }
  // the benchmark's closes; older files call them qqq_close
  const benchCloses = (data) => data.bench_close || data.qqq_close;
  const TIMES = { 2: "Two", 3: "Three" };

  /** Daily-return comparison with the benchmark over the window. */
  function benchmark(data, res) {
    const bc = benchCloses(data), lev = tickerInfo(data).leverage;
    const r = [], q = [];
    for (let i = res.start + 1; i <= res.end; i++) {
      r.push(data.close[i] / data.close[i - 1] - 1);
      q.push(bc[i] / bc[i - 1] - 1);
    }
    const mr = mean(r), mq = mean(q);
    let cov = 0, vq = 0, vr = 0;
    for (let j = 0; j < r.length; j++) {
      cov += (r[j] - mr) * (q[j] - mq); vq += (q[j] - mq) ** 2; vr += (r[j] - mr) ** 2;
    }
    const s = res.start, e = res.end;
    const tqRet = (data.close[e] / data.close[s] - 1) * 100;
    const qqRet = (bc[e] / bc[s] - 1) * 100;
    return {
      beta: cov / vq, corr: cov / Math.sqrt(vq * vr), symReturn: tqRet, benchReturn: qqRet, leverage: lev,
      naiveLev: qqRet * lev, // leverage x the period return, to show the daily-reset gap (leveraged funds only)
      volSym: Math.sqrt(vr / r.length) * Math.sqrt(252) * 100,
      volBench: Math.sqrt(vq / q.length) * Math.sqrt(252) * 100,
    };
  }

  /** Volume traded at each price bucket over the window (optional chart overlay). */
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

  /** Top support levels for several windows, and whether each level recurs across windows. */
  function compareWindows(data, opts, windows = [21, 63, 126, 252]) {
    const base = normalize(opts);
    const runs = windows.map((w) => ({ window: w, res: analyze(data, { ...base, window: w }) }));
    const tol = runs[0].res.tol;
    const all = runs.flatMap((r) => r.res.supports.map((z) => ({ w: r.window, z })));
    for (const a of all) {
      const seen = new Set(all.filter((b) => Math.abs(b.z.price - a.z.price) <= tol).map((b) => b.w));
      a.z.windowsSeen = seen.size;
    }
    return runs;
  }

  const GROUPS = ["Support levels", "Trend", "Momentum & volatility", "Risk & leverage"];
  const pct2 = (v) => (v > 0 ? "+" : "") + v.toFixed(1) + "%";

  /**
   * Plain-language findings for the current window, grouped for scanning.
   * Returns [{ group, html }] — at least ten items in any normal window.
   * `ctx.runs` is the output of compareWindows(); pass it to get the
   * cross-window confirmation finding (the page already computes it once).
   */
  function findings(data, res, lab, fmt, fmtDate, ctx = {}) {
    const f = fmt || ((v) => (v == null || !isFinite(v) ? "–" : "$" + v.toFixed(2)));
    const fd = fmtDate || ((d) => d);
    // a zone of one swing low is one price, not "$707.23–$707.23"
    const band = (z) => (z.high - z.low < 0.005 ? f(z.price) : `${f(z.low)}–${f(z.high)}`);
    const pct = (v) => (v == null || !isFinite(v) ? "–" : Math.abs(v).toFixed(1) + "%");
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : /(ch|sh|s|x|z)$/.test(w) ? "es" : "s"}`;
    const i = res.end;
    const out = [];
    const add = (group, html) => out.push({ group, html });
    const tk = tickerInfo(data);
    // levels may be found over a longer stretch than the window (the page looks back at least 200 sessions)
    const lb = res.levelStart != null && res.levelStart < res.start ? `in the last ${res.end - res.levelStart + 1} sessions` : "in this window";

    const s = res.supports[0];
    const nxt = res.supports[1];
    const strongest = [...res.supports].sort((a, b) => b.score - a.score)[0];

    /* ---------------------------------------------------------- support levels */
    if (s) {
      const where = s.inZone
        ? ", and price is sitting inside it right now"
        : ` — about ${pct(s.distancePct)} below the last close`;
      add(GROUPS[0], `<b>${s.id} is the first floor under price, at ${band(s)}</b>${where}. ` +
        `Buyers have turned it higher ${plural(s.touches, "time")} here, most recently on ${fd(s.date)}, ` +
        `which scores it a <b>${s.strength.toLowerCase()}</b> level (${s.score}/100).`);
    } else if (res.fallbacks.length) {
      add(GROUPS[0], `<b>No confirmed support was found below the price</b> ${lb}` +
        (res.above.length
          ? ` — every level found here is above the close, because the price has fallen through ${res.above.length === 1 ? "it" : "them"}. `
          : ` — there simply have not been enough swing lows yet. `) +
        `Fall back to ${res.fallbacks.map((x) => `the ${x.label.toLowerCase()} at ${f(x.price)}`).join(" and ")}, or widen the window.`);
    }

    const up = res.above[0];
    if (up) {
      add(GROUPS[0], `<b>The nearest level above the price is ${up.id} at ${band(up)}</b>, ${pct(up.distancePct)} above the last close. ` +
        `It held ${plural(up.touches, "time")} before the price closed below it` +
        `${up.brokeDate ? ` on ${fd(up.brokeDate)}` : ""}. A floor that gave way is often where a later rise stalls` +
        `${res.above.length > 1 ? `; ${plural(res.above.length - 1, "more level")} sit${res.above.length === 2 ? "s" : ""} higher up` : ""}.`);
    }

    if (s && nxt) {
      const gapPct = (s.price / nxt.price - 1) * 100;
      const gapDays = (s.price - nxt.price) / res.atr;
      add(GROUPS[0], `If ${s.id} gives way, the next floor is <b>${nxt.id} at ${f(nxt.price)}</b> — a further ${pct(gapPct)} down, ` +
        `or roughly ${gapDays.toFixed(1)} typical days of movement. That gap is open air: no level in between has been defended.`);
    } else if (s) {
      add(GROUPS[0], `${s.id} is the <b>only</b> confirmed level below price ${lb}, so there is nothing mapped underneath it. ` +
        `A longer window would show what has held further down.`);
    }

    if (strongest) {
      const same = strongest === s;
      add(GROUPS[0], `The most dependable level here is <b>${strongest.id} at ${f(strongest.price)}</b>` +
        `${same ? ", which is also the nearest one" : `, ${pct(strongest.distancePct)} below the close`} — ` +
        `${plural(strongest.touches, "touch")} on ${strongest.volumeLabel.toLowerCase()} volume ` +
        `(${strongest.volumeRatio.toFixed(1)}× the window average), scoring ${strongest.score}/100.`);
    }

    if (ctx.runs) {
      const seen = [];
      for (const r of ctx.runs) for (const z of r.res.supports) {
        if (z.windowsSeen >= 3 && !seen.some((x) => Math.abs(x.price - z.price) <= res.tol)) seen.push(z);
      }
      seen.sort((a, b) => b.price - a.price);
      add(GROUPS[0], seen.length
        ? `<b>${plural(seen.length, "level")} survive${seen.length === 1 ? "s" : ""} at least three of the four look-back lengths</b> ` +
          `(${seen.map((z) => f(z.price)).join(", ")}). Levels that persist across 1, 3, 6 and 12-month windows are the least likely to be an artefact of the window chosen.`
        : `<b>No level appears in three or more of the four look-back lengths.</b> The floors below are specific to this window — treat them as shorter-lived than usual, and compare the window chart before relying on them.`);
    }

    const rl = res.rollingLow[i];
    if (rl != null) {
      const rlPct = (rl / res.price - 1) * 100;
      add(GROUPS[0], `The immediate floor is the <b>${res.opts.period}-day rolling low at ${f(rl)}</b>, ${pct(rlPct)} under the close — ` +
        `the line in the sand for this week rather than this quarter.` +
        (res.broken.length
          ? ` ${plural(res.broken.length, "zone")} ${lb} ${res.broken.length === 1 ? "has" : "have"} been broken — the price closed below ${res.broken.length === 1 ? "it" : "them"} — and ${res.broken.length === 1 ? "is" : "are"} listed as ${res.broken.length === 1 ? "a level" : "levels"} above the price.`
          : ` No zone ${lb} has broken.`));
    }

    /* ------------------------------------------------------------------ trend */
    const t = lab.trend;
    const why = {
      Uptrend: "price is above both its 50 and 200-day averages, the 50-day is rising, and swing lows are stepping higher",
      Downtrend: "price is below both its 50 and 200-day averages, the 50-day is falling, and swing lows are stepping lower",
      Mixed: "the moving averages, the 50-day slope and the swing lows do not agree",
    }[t.label];
    add(GROUPS[1], `${tk.symbol} is in a${t.label === "Uptrend" ? "n" : ""} <b>${t.label.toLowerCase()}</b>${t.label === "Mixed" ? " trend" : ""}: ${why}. ` +
      `${t.label === "Mixed" ? "A mixed read is the honest answer when the checks conflict — support matters more than trend in this state." : "All three trend checks point the same way."}`);

    const c = data.close[i];
    const above = (v) => (v == null ? "n/a" : c > v ? "above" : "below");
    add(GROUPS[1], `Price sits <b>${above(data.sma50[i])} the 50-day average</b> (${f(data.sma50[i])}) and <b>${above(data.sma200[i])} the 200-day</b> (${f(data.sma200[i])})` +
      `${t.slopePct == null ? "" : `, with the 50-day ${t.slopePct >= 0 ? "rising" : "falling"} ${pct(t.slopePct)} over the last 20 sessions`}` +
      `${lab.maCross ? `. The last ${lab.maCross.type.toLowerCase()} was on ${fd(lab.maCross.date)}` : ""}.`);

    const low12 = Math.min(...data.low.slice(Math.max(0, data.close.length - 252)));
    const posPct = ((c - low12) / (lab.high12m - low12)) * 100;
    const swings = t.checks.swings;
    add(GROUPS[1], `The close is <b>${pct(lab.drawdown)} below the 12-month high</b> of ${f(lab.high12m)} and sits ${posPct.toFixed(0)}% of the way up the 12-month range ` +
      `(${f(low12)}–${f(lab.high12m)}). The search for levels (${lb.replace("in ", "")}) found ${plural(res.pivots.lows.length, "confirmed swing low")}` +
      `${res.pivots.lows.length < 2 ? " — too few to say whether lows are stepping up or down" : `, and the last two are <b>${swings > 0 ? "rising" : swings < 0 ? "falling" : "level"}</b>`}.`);

    /* -------------------------------------------------- momentum & volatility */
    const rv = lab.rsi.value;
    const rsiTxt = rv >= 70 ? "<b>overbought</b> — the recent rise is stretched and pullbacks are more likely than usual"
      : rv >= 60 ? "approaching overbought — the rise is getting stretched"
      : rv <= 30 ? "<b>oversold</b> — selling looks stretched, which is the condition in which support most often holds"
      : rv <= 40 ? "weak but not yet oversold"
      : "neutral, so it is neither helping nor hurting the levels below";
    add(GROUPS[2], `RSI is <b>${rv.toFixed(0)}</b>, ${rsiTxt}. RSI is a 0–100 momentum gauge; it confirms the levels rather than calling them.`);

    add(GROUPS[2], `MACD is <b>${lab.macd.label.toLowerCase()}</b>${lab.macd.crossDate ? `, having crossed ${lab.macd.crossDir} on ${fd(lab.macd.crossDate)}` : ""}, ` +
      `and the gap to its signal line is ${lab.macd.hist >= 0 ? "positive and " : "negative and "}${Math.abs(lab.macd.hist).toFixed(2)} wide — momentum is ` +
      `<b>${lab.macd.hist >= 0 ? "building" : "fading"}</b>.`);

    const atrSeries = [];
    for (let j = res.start; j <= i; j++) if (data.atr14[j] != null) atrSeries.push((data.atr14[j] / data.close[j]) * 100);
    atrSeries.sort((a, b) => a - b);
    const atrMed = atrSeries.length ? atrSeries[Math.floor(atrSeries.length / 2)] : lab.atr.pct;
    const atrRatio = atrMed ? lab.atr.pct / atrMed : 1;
    const regime = atrRatio <= 0.9 ? "calmer than usual" : atrRatio >= 1.1 ? "choppier than usual" : "about normal";
    const bbPct = (lab.bollinger.position * 100).toFixed(0);
    const bbTxt = {
      "Above upper band": "closed <b>above its upper Bollinger Band</b> — past the top of its normal 20-day range, which is a stretched reading rather than a comfortable one",
      "Near upper band": `is <b>hugging the upper Bollinger Band</b> (${bbPct}% of its normal 20-day range)`,
      "Near lower band": `is <b>hugging the lower Bollinger Band</b> (${bbPct}% of its normal 20-day range)`,
      "Below lower band": "closed <b>below its lower Bollinger Band</b> — under the bottom of its normal 20-day range",
    }[lab.bollinger.label] || `is <b>mid-range</b> inside its Bollinger Bands (${bbPct}% of its normal 20-day range)`;
    add(GROUPS[2], `Price ${bbTxt}. Daily swings average ${lab.atr.pct.toFixed(1)}% against a ${atrMed.toFixed(1)}% median for this window ` +
      `(<b>${regime}</b>), and the latest session traded ${lab.volume.ratio.toFixed(1)}× its 20-day average volume (${lab.volume.label.toLowerCase()}).`);

    /* ------------------------------------------------------- risk & leverage */
    if (s) {
      const stop = s.low - res.atr;
      add(GROUPS[3], `${tk.symbol} moves about <b>${lab.atr.pct.toFixed(1)}% on a typical day</b>, so any level can be pierced and reclaimed inside one session. ` +
        `Placing a stop a full day's range under ${s.id} puts it near <b>${f(stop)}</b>, ${pct((stop / res.price - 1) * 100)} below the close.`);
    }

    const b = benchmark(data, res);
    add(GROUPS[3], `Over this window ${tk.symbol} returned ${pct2(b.symReturn)} against ${pct2(b.benchReturn)} for ${tk.benchmark}. ` +
      (tk.leverage > 1
        ? `${TIMES[tk.leverage] || tk.leverage} times the index return would have been ${pct2(b.naiveLev)}, so <b>daily resetting cost ${pct(b.naiveLev - b.symReturn)} of compounding</b>. `
        : "") +
      `Daily beta to ${tk.benchmark} is ${b.beta.toFixed(2)}× and annualised volatility ${b.volSym.toFixed(0)}% versus ${b.volBench.toFixed(0)}%.`);

    const pending = res.pivots.pendingLows.length;
    add(GROUPS[3], `These levels are descriptions of past trading, not forecasts, and leverage lets them break hard. ` +
      (pending
        ? `<b>${plural(pending, "recent dip")} cannot be confirmed yet</b> — a swing low needs ${res.opts.period} sessions after it — so the picture can still shift.`
        : `Every swing low ${lb} is confirmed, but the most recent ${res.opts.period} sessions can still produce a new one.`));

    return out;
  }

  /**
   * The bottom line: one headline plus a handful of labelled lines, written for
   * someone who will read this and nothing else. Everything here is also in
   * findings(); this is the summary that goes above it, not a second analysis.
   */
  function bottomLine(data, res, lab, fmt, fmtDate) {
    const f = fmt || ((v) => (v == null || !isFinite(v) ? "–" : "$" + v.toFixed(2)));
    const band = (z) => (z.high - z.low < 0.005 ? f(z.price) : `${f(z.low)}–${f(z.high)}`); // one low: one price
    const whole = (v) => (v == null || !isFinite(v) ? "–" : Math.abs(v).toFixed(0) + "%");
    const s = res.supports[0];
    const nxt = res.supports[1];
    const rows = [];

    const up = res.above[0];
    const tk = tickerInfo(data);
    const headline = !s
      ? `${tk.symbol} closed at <b>${f(res.price)}</b>. <b>No floor has formed below it</b> in this period` +
        (up
          ? ` — the nearest level is above the price, around ${f(up.price)}, ${whole(up.distancePct)} higher.`
          : ` — the price has not dipped and recovered often enough to mark one out.`)
      : s.inZone
        ? `${tk.symbol} closed at <b>${f(res.price)}</b> and is <b>sitting on its nearest floor</b>, ${band(s)}. That is the level being tested right now.`
        : `${tk.symbol} closed at <b>${f(res.price)}</b>, about <b>${whole(s.distancePct)} above its nearest floor</b>, around ${f(s.price)}.`;

    if (s) {
      const days = Math.abs(res.price - s.price) / res.atr;
      rows.push({ label: "Nearest floor", html:
        `<b>${band(s)}</b> — ${s.inZone ? "the price is inside it now" : `${whole(s.distancePct)} below, or roughly ${days.toFixed(0)} ordinary day${days < 1.5 ? "" : "s"} of movement away`}. ` +
        `Buyers have stepped in and pushed the price back up there ${s.touches} time${s.touches > 1 ? "s" : ""}, which is why it rates as a <b>${s.strength.toLowerCase()}</b> floor.` });
    } else if (res.fallbacks.length) {
      rows.push({ label: "Nearest floor", html:
        `None found. The rough guides are ${res.fallbacks.map((x) => `the ${x.label.toLowerCase()} at ${f(x.price)}`).join(" and ")} — or look back over a longer period.` });
    }

    if (s && nxt) {
      rows.push({ label: "If that breaks", html:
        `The next floor down is <b>${f(nxt.price)}</b>, a further ${whole((s.price / nxt.price - 1) * 100)} lower. Nothing in between has held the price up before.` });
    }

    if (up) {
      rows.push({ label: "Above the price", html:
        `<b>${band(up)}</b>, ${whole(up.distancePct)} higher. It used to be a floor` +
        `${up.brokeDate ? `, until the price closed below it on ${fmtDate ? fmtDate(up.brokeDate) : up.brokeDate}` : ""}. ` +
        `Rises often stall where an old floor gave way.` });
    }

    const t = lab.trend;
    rows.push({ label: "Trend", html: `<b>${t.label}</b> — ` + {
      Uptrend: "the price is above its average for both the last few months and the last year, and each dip has bottomed out higher than the one before.",
      Downtrend: "the price is below its average for both the last few months and the last year, and each bounce has topped out lower than the one before.",
      Mixed: "the signs point in different directions, so the floors below matter more than the overall direction right now.",
    }[t.label] });

    // Deliberately says what the indicators mean rather than naming them. RSI, MACD
    // and the Bollinger position all appear by name further down the page, where
    // there is room to explain them; the summary has to stand on its own.
    const rv = lab.rsi.value;
    const mood = rv >= 70 ? ["Buyers are firmly in control", "The climb has been steep enough that a pause or pullback would be normal from here."]
      : rv >= 60 ? ["Buyers have the upper hand", "The move up is starting to look stretched."]
      : rv <= 30 ? ["Sellers are firmly in control", "The selling looks overdone, which is the condition in which floors most often hold."]
      : rv <= 40 ? ["Sellers have the upper hand", "There is little buying interest at the moment."]
      : ["Buyers and sellers are fairly evenly matched", "Neither side is forcing the price anywhere just now."];
    let mo = `<b>${mood[0]}.</b> ${mood[1]} Over recent weeks the balance has been shifting ` +
      `<b>${lab.macd.label === "Bullish" ? "towards buyers" : "towards sellers"}</b>.`;
    if (lab.bollinger.label === "Above upper band") mo += " The price also finished above the range it has been trading in lately, so a breather would be unremarkable.";
    else if (lab.bollinger.label === "Below lower band") mo += " The price also finished below the range it has been trading in lately, so a bounce would be unremarkable.";
    rows.push({ label: "Buyers vs sellers", html: mo });

    rows.push({ label: "Risk", html:
      (tk.leverage > 1
        ? `${tk.symbol} aims to move <b>${(TIMES[tk.leverage] || String(tk.leverage)).toLowerCase()} times as much as the ${tk.index} does each day</b>, and swings about <b>${lab.atr.pct.toFixed(1)}% in an ordinary day</b>. `
        : `${tk.symbol} swings about <b>${lab.atr.pct.toFixed(1)}% in an ordinary day</b>. `) +
      `A floor can be broken and won back inside a single day, so treat these as areas to watch rather than exact lines.` });

    return { headline, rows };
  }

  /**
   * Where the page reads its data. On GitHub Pages (owner.github.io/repo/) that is the
   * market-data branch, through GitHub's raw-file address, so the daily data needs no commit
   * on main; anywhere else (a local preview, the tests) it is the site's own data/ folder.
   */
  function dataBase(loc, branch = "market-data") {
    const owner = /^([a-z0-9-]+)\.github\.io$/i.exec(loc.hostname || "");
    const repo = (loc.pathname || "/").split("/")[1] || "";
    return owner && /^[\w-]+$/.test(repo) ? `https://raw.githubusercontent.com/${owner[1]}/${repo}/${branch}/` : "";
  }

  /** Compact snapshot used for the daily history files and "what changed". */
  function snapshot(data, opts) {
    const res = analyze(data, opts);
    const lab = labels(data, res);
    const z = (x) => ({
      id: x.id, price: +x.price.toFixed(2), low: +x.low.toFixed(2), high: +x.high.toFixed(2),
      touches: x.touches, score: x.score, strength: x.strength, status: x.status, last_test: x.date,
    });
    return {
      as_of: data.dates[res.end], close: +res.price.toFixed(2),
      settings: {
        window: res.opts.window, period: res.opts.period, clusterMult: res.opts.clusterMult, minTouches: res.opts.minTouches,
        levels_from: Math.max(res.opts.window, res.opts.minLookback || 0), // sessions searched for levels
        top: Number.isFinite(res.opts.topN) ? res.opts.topN : "all",       // how many levels below are kept
      },
      trend: lab.trend.label, rsi: +lab.rsi.value.toFixed(1), rsi_label: lab.rsi.label,
      macd: lab.macd.label, ma_cross: lab.maCross,
      atr_pct: +lab.atr.pct.toFixed(2), drawdown: +lab.drawdown.toFixed(2),
      supports: res.supports.map(z),
      broken: res.broken.map((x) => ({ ...z(x), id: x.id || null })),
    };
  }

  /** Compare two snapshots and describe what changed. */
  function diffSnapshots(prev, cur, tolPct = 1.5) {
    const out = [];
    if (!prev) return out;
    const near = (a, b) => Math.abs(a.price / b.price - 1) * 100 <= tolPct;
    const find = (list, z) => (list || []).find((p) => near(p, z));
    const money = (v) => "$" + v.toFixed(2);
    const listed = cur.settings && cur.settings.top === "all"; // every level kept, not the strongest few

    for (const z of cur.supports) {
      if (find(prev.supports, z)) continue;
      out.push(find(prev.broken, z)
        ? { type: "reclaimed", text: `Price climbed back above ${money(z.price)}; that zone is acting as support again.` }
        : { type: "new", text: z.last_test === cur.as_of && z.touches === 1
          ? `A new support zone formed at ${money(z.price)} after today's swing low.`
          : listed
            ? `Support at ${money(z.price)} (${z.touches} touch${z.touches > 1 ? "es" : ""}) is now on the list of levels.`
            : `Support at ${money(z.price)} (${z.touches} touch${z.touches > 1 ? "es" : ""}) moved into the top ${Math.max(cur.supports.length, 1)}.` });
    }
    for (const p of prev.supports || []) {
      if (find(cur.supports, p)) continue;
      out.push(find(cur.broken, p)
        ? { type: "broken", text: `Support at ${money(p.price)} broke — price closed below the zone.` }
        : { type: "dropped", text: listed ? `Support at ${money(p.price)} is no longer on the list of levels.` : `Support at ${money(p.price)} dropped out of the top list.` });
    }
    if (prev.trend !== cur.trend) out.push({ type: "trend", text: `Trend changed from ${prev.trend} to ${cur.trend}.` });
    if (prev.rsi_label !== cur.rsi_label) out.push({ type: "rsi", text: `RSI moved from ${prev.rsi_label.toLowerCase()} to ${cur.rsi_label.toLowerCase()} (${cur.rsi}).` });
    if (prev.macd !== cur.macd) out.push({ type: "macd", text: `MACD turned ${cur.macd.toLowerCase()}.` });
    const pc = prev.ma_cross?.date, cc = cur.ma_cross?.date;
    if (cc && cc !== pc) out.push({ type: "cross", text: `${cur.ma_cross.type} on ${cc}.` });
    return out;
  }

  /* ------------------------------------------------------------------ chart cadence */

  /** The Monday of the week containing an ISO date, as an ISO date. */
  function weekStart(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); // Monday = 0
    return t.toISOString().slice(0, 10);
  }

  /**
   * One bar per calendar week: each Monday's session.
   *
   * This samples rather than aggregates — the bar is that single Monday, not a
   * summary of the week. Where Monday was a market holiday the week's first
   * trading day stands in, so every week still gets exactly one bar and the
   * date axis stays truthful about which session is drawn.
   *
   * Being a sample, it does not show what happened on the other four days: a
   * support level tested on a Wednesday will not appear on the chart, though it
   * still counts in the levels table, which is always computed on daily data.
   * The chart caption says so.
   */
  function resampleWeekly(data, res) {
    const n = data.dates.length;
    const groups = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      const wk = weekStart(data.dates[i]);
      if (!cur || cur.week !== wk) groups.push((cur = { week: wk, idx: [] }));
      cur.idx.push(i);
    }
    // the Monday itself, or the week's first session when Monday was a holiday
    const srcIdx = groups.map((g) => {
      const monday = g.idx.find((i) => data.dates[i] === g.week);
      return monday == null ? g.idx[0] : monday;
    });

    const out = { dates: srcIdx.map((i) => data.dates[i]) };
    for (const k of Object.keys(data)) {
      if (Array.isArray(data[k]) && k !== "dates") out[k] = srcIdx.map((i) => data[k][i]);
    }

    // map daily positions onto the week that contains them
    const weekOf = new Array(n);
    groups.forEach((g, w) => g.idx.forEach((i) => (weekOf[i] = w)));
    const uniq = (a) => [...new Set(a)].sort((x, y) => x - y);

    return {
      data: out,
      dates: out.dates,
      start: weekOf[Math.min(res.start, n - 1)],
      levelStart: weekOf[Math.min(res.levelStart ?? res.start, n - 1)],
      end: groups.length - 1,
      lows: uniq(res.pivots.lows.map((i) => weekOf[i])),
      pendingLows: uniq(res.pivots.pendingLows.map((i) => weekOf[i])),
      used: uniq(res.supports.flatMap((z) => z.pivots).map((i) => weekOf[i])),
      rollingLow: srcIdx.map((i) => res.rollingLow[i]),
      srcIdx,
      weekly: true,
    };
  }

  /** The display model the chart draws: daily as-is, or weekly bars. */
  function chartModel(data, res, cadence) {
    if (cadence !== "weekly") {
      return {
        data, dates: data.dates, start: res.start, levelStart: res.levelStart ?? res.start, end: res.end,
        lows: res.pivots.lows, pendingLows: res.pivots.pendingLows,
        used: res.supports.flatMap((z) => z.pivots),
        rollingLow: res.rollingLow, srcIdx: data.dates.map((_, i) => i), weekly: false,
      };
    }
    return resampleWeekly(data, res);
  }

  /* ------------------------------------------------------------------ freshness */

  // one-off closures the rules below cannot know (2025-01-09: day of mourning for President Carter)
  const EXTRA_CLOSURES = new Set(["2025-01-09"]);

  /**
   * Whether the US stock market is closed for a holiday on this weekday (NYSE rules).
   * Checked against two years of recorded prices: every weekday missing from them is a
   * holiday here, and no holiday here has prices.
   */
  function isMarketHoliday(date) {
    const y = date.getFullYear(), m = date.getMonth(), day = date.getDate(), wd = date.getDay();
    const pad = (n) => String(n).padStart(2, "0");
    if (EXTRA_CLOSURES.has(`${y}-${pad(m + 1)}-${pad(day)}`)) return true;
    const nth = (n) => Math.floor((day - 1) / 7) + 1 === n; // the nth such weekday of the month
    const last = day + 7 > new Date(y, m + 1, 0).getDate(); // the last such weekday of the month
    // fixed dates move to Friday when on a Saturday and to Monday when on a Sunday;
    // New Year's Day on a Saturday is not moved back into December
    const fixed = (mm, dd, back = true) => (m === mm && day === dd)
      || (back && wd === 5 && m === mm && day === dd - 1)
      || (wd === 1 && m === mm && day === dd + 1);
    if (fixed(0, 1, false)) return true; // New Year's Day
    if (m === 0 && wd === 1 && nth(3)) return true; // Martin Luther King Jr. Day
    if (m === 1 && wd === 1 && nth(3)) return true; // Presidents' Day
    if (m === 4 && wd === 1 && last) return true; // Memorial Day
    if (y >= 2022 && fixed(5, 19)) return true; // Juneteenth
    if (fixed(6, 4)) return true; // Independence Day
    if (m === 8 && wd === 1 && nth(1)) return true; // Labor Day
    if (m === 10 && wd === 4 && nth(4)) return true; // Thanksgiving
    if (fixed(11, 25)) return true; // Christmas
    // Good Friday: two days before Easter Sunday (anonymous Gregorian algorithm)
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
    const easter = new Date(y, Math.floor((h + l - 7 * mm + 114) / 31) - 1, ((h + l - 7 * mm + 114) % 31) + 1);
    const goodFriday = new Date(easter.getFullYear(), easter.getMonth(), easter.getDate() - 2);
    return goodFriday.getMonth() === m && goodFriday.getDate() === day;
  }

  const isSession = (d) => d.getDay() !== 0 && d.getDay() !== 6 && !isMarketHoliday(d);

  /**
   * The most recent trading day whose US close has passed, as a local-midnight Date.
   * `nowNY` must carry New York wall-clock time in its local fields.
   */
  function lastCompletedSession(nowNY) {
    const d = new Date(nowNY.getFullYear(), nowNY.getMonth(), nowNY.getDate());
    if (nowNY.getHours() < 16) d.setDate(d.getDate() - 1); // today has not closed yet
    while (!isSession(d)) d.setDate(d.getDate() - 1);
    return d;
  }

  /** Trading days strictly after `from`, up to and including `to`. */
  function sessionsBetween(from, to) {
    let n = 0;
    const d = new Date(from);
    for (d.setDate(d.getDate() + 1); d <= to; d.setDate(d.getDate() + 1)) {
      if (isSession(d)) n++;
    }
    return n;
  }

  /**
   * How current a published file is, as a state the page can speak about:
   *   current  — nothing newer exists to publish
   *   pending  — only today's close is missing: the refresh runs after the close and
   *              has always published the same evening (Sep 21 – Oct 23, 2026)
   *   stale    — an earlier session is missing, so a run has failed
   * The old code inferred this from a hard-coded "refresh lands by 19:00" rule,
   * which said nothing to the reader and went wrong when a run started later.
   */
  function freshness(asOf, nowNY) {
    const [y, mo, da] = asOf.split("-").map(Number);
    const last = lastCompletedSession(nowNY);
    const behind = sessionsBetween(new Date(y, mo - 1, da), last);
    const isToday = last.getDate() === nowNY.getDate() && last.getMonth() === nowNY.getMonth()
      && last.getFullYear() === nowNY.getFullYear();
    const pad = (n) => String(n).padStart(2, "0");
    return {
      state: behind === 0 ? "current" : behind === 1 && isToday ? "pending" : "stale",
      behind,
      expected: `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`,
      expectedIsToday: isToday,
    };
  }

  /** Slice the payload's arrays up to (and including) index `end` — used for backfilling history. */
  function truncate(data, end) {
    const out = { ...data };
    for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) out[k] = v.slice(0, end + 1);
    return out;
  }

  /** Flatten a ticker's data file into { dates, open, ..., sma50, bench_close, ..., meta }. */
  function fromPayload(p) {
    const d = { dates: p.dates, ...p.series, meta: p.meta };
    if (!d.bench_close && d.qqq_close) d.bench_close = d.qqq_close; // files written before the multi-ticker change
    return d;
  }

  return {
    DEFAULTS, LIMITS, WINDOW_PRESETS, LEVEL_SESSIONS, PAGE_SETTINGS, WEIGHTS, TIERS,
    normalize, strengthTier, tickerInfo, findPivots, rollingLow, cluster, analyze, labels, trendCall, benchmark,
    volumeProfile, compareWindows, findings, bottomLine, dataBase, snapshot, diffSnapshots, truncate, fromPayload,
    lastCompletedSession, sessionsBetween, freshness, isMarketHoliday,
    weekStart, resampleWeekly, chartModel,
  };
});
