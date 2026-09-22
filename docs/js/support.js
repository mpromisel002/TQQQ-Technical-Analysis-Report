/*
 * TQQQ support method — the single implementation used by the page,
 * the daily snapshot job (Node) and the unit tests.
 *
 * Steps (see the Method panel on the page):
 *   1. Swing lows confirmed by `period` sessions on each side (default 3).
 *   2. Rolling `period`-session low (step line).
 *   3. Cluster swing lows within clusterMult × ATR(14) into zones (volume-weighted price).
 *   4. Score zones: touches 40%, recency 30%, volume 20%, bounce 10%.
 *
 * The report covers support only. Swing highs / resistance are deliberately not
 * part of the output: the brief asks for support levels, and leaving overhead
 * levels off keeps the chart readable.
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
    const start = Math.max(0, n - o.window);
    const endIdx = n - 1;
    const price = data.close[endIdx];
    const atr = data.atr14[endIdx] ?? mean(data.high.slice(start).map((h, j) => h - data.low[start + j]));
    const tol = o.clusterMult * atr;
    const half = tol / 2;
    const avgVol = mean(data.volume.slice(start));

    const lowP = findPivots(data.low, o.period, start, "low");

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
      let lastTest = lastI, brokeBefore = false;
      for (let i = lastI + 1; i <= endIdx; i++) {
        if (data.low[i] <= bandHi && data.high[i] >= bandLo) lastTest = i;
        if (data.close[i] < lo - half) brokeBefore = true;
      }
      return {
        price: z.price, low: lo, high: hi,
        touches: members.length,
        pivots: members.map((m) => m.i),
        firstIdx: members[0].i, lastPivotIdx: lastI, lastTestIdx: lastTest,
        avgVolume: mean(members.map((m) => m.v)),
        bounce: mean(bounces),
        brokeBefore,
      };
    }).filter((z) => z.touches >= o.minTouches);

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
      z.strength = strengthTier(z.score);
      z.volumeRatio = z.avgVolume / avgVol;
      z.volumeLabel = z.volumeRatio >= 1.3 ? "Heavy" : z.volumeRatio <= 0.8 ? "Light" : "Normal";
      z.distancePct = (z.price / price - 1) * 100;
      // a zone is broken once price closes clearly below it; until then it is live support
      z.broken = price < z.low - half;
      z.inZone = !z.broken && price <= z.high + half;
      z.status = z.broken ? "Broken"
        : z.inZone ? "In play"
        : endIdx - z.lastTestIdx <= 10 ? "Recently tested" : "Holding";
      z.date = data.dates[z.lastTestIdx];
      z.firstDate = data.dates[z.firstIdx];
    }

    // live support: strongest `topN`, then listed nearest-to-price first
    const supports = zones.filter((z) => !z.broken)
      .sort((a, b) => b.score - a.score).slice(0, o.topN)
      .sort((a, b) => b.price - a.price)
      .map((z, i) => Object.assign(z, { rank: i + 1, id: "S" + (i + 1) }));
    // zones price has closed below — kept for the "what changed" feed, not drawn on the chart
    const broken = zones.filter((z) => z.broken).sort((a, b) => a.price - b.price);

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
      zones, supports, broken, fallbacks,
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
    const pct = (v) => (v == null || !isFinite(v) ? "–" : Math.abs(v).toFixed(1) + "%");
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : /(ch|sh|s|x|z)$/.test(w) ? "es" : "s"}`;
    const i = res.end;
    const out = [];
    const add = (group, html) => out.push({ group, html });

    const s = res.supports[0];
    const nxt = res.supports[1];
    const strongest = [...res.supports].sort((a, b) => b.score - a.score)[0];

    /* ---------------------------------------------------------- support levels */
    if (s) {
      const where = s.inZone
        ? ", and price is sitting inside it right now"
        : ` — about ${pct(s.distancePct)} below the last close`;
      add(GROUPS[0], `<b>${s.id} is the first floor under price, at ${f(s.low)}–${f(s.high)}</b>${where}. ` +
        `Buyers have turned it higher ${plural(s.touches, "time")} here, most recently on ${fd(s.date)}, ` +
        `which scores it a <b>${s.strength.toLowerCase()}</b> level (${s.score}/100).`);
    } else if (res.fallbacks.length) {
      add(GROUPS[0], `<b>No confirmed support was found below the price</b> in this window — there simply have not been enough swing lows yet. ` +
        `Fall back to ${res.fallbacks.map((x) => `the ${x.label.toLowerCase()} at ${f(x.price)}`).join(" and ")}, or widen the window.`);
    }

    if (s && nxt) {
      const gapPct = (s.price / nxt.price - 1) * 100;
      const gapDays = (s.price - nxt.price) / res.atr;
      add(GROUPS[0], `If ${s.id} gives way, the next floor is <b>${nxt.id} at ${f(nxt.price)}</b> — a further ${pct(gapPct)} down, ` +
        `or roughly ${gapDays.toFixed(1)} typical days of movement. That gap is open air: no level in between has been defended.`);
    } else if (s) {
      add(GROUPS[0], `${s.id} is the <b>only</b> confirmed level below price in this window, so there is nothing mapped underneath it. ` +
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
          ? ` ${plural(res.broken.length, "zone")} in this window ${res.broken.length === 1 ? "has already broken and no longer counts" : "have already broken and no longer count"} as support.`
          : ` No zone in this window has broken.`));
    }

    /* ------------------------------------------------------------------ trend */
    const t = lab.trend;
    const why = {
      Uptrend: "price is above both its 50 and 200-day averages, the 50-day is rising, and swing lows are stepping higher",
      Downtrend: "price is below both its 50 and 200-day averages, the 50-day is falling, and swing lows are stepping lower",
      Mixed: "the moving averages, the 50-day slope and the swing lows do not agree",
    }[t.label];
    add(GROUPS[1], `TQQQ is in a${t.label === "Uptrend" ? "n" : ""} <b>${t.label.toLowerCase()}</b>${t.label === "Mixed" ? " trend" : ""}: ${why}. ` +
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
      `(${f(low12)}–${f(lab.high12m)}). The window holds ${plural(res.pivots.lows.length, "confirmed swing low")}` +
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
      add(GROUPS[3], `TQQQ moves about <b>${lab.atr.pct.toFixed(1)}% on a typical day</b>, so any level can be pierced and reclaimed inside one session. ` +
        `Placing a stop a full day's range under ${s.id} puts it near <b>${f(stop)}</b>, ${pct((stop / res.price - 1) * 100)} below the close.`);
    }

    const b = benchmark(data, res);
    add(GROUPS[3], `Over this window TQQQ returned ${pct2(b.tqqqReturn)} against ${pct2(b.qqqReturn)} for QQQ. ` +
      `Three times the index return would have been ${pct2(b.naive3x)}, so <b>daily resetting cost ${pct(b.naive3x - b.tqqqReturn)} of compounding</b>. ` +
      `Daily beta is ${b.beta.toFixed(2)}× and annualised volatility ${b.volTqqq.toFixed(0)}% versus ${b.volQqq.toFixed(0)}%.`);

    const pending = res.pivots.pendingLows.length;
    add(GROUPS[3], `These levels are descriptions of past trading, not forecasts, and leverage lets them break hard. ` +
      (pending
        ? `<b>${plural(pending, "recent dip")} cannot be confirmed yet</b> — a swing low needs ${res.opts.period} sessions after it — so the picture can still shift.`
        : `Every swing low in this window is confirmed, but the most recent ${res.opts.period} sessions can still produce a new one.`));

    return out;
  }

  /**
   * The bottom line: one headline plus a handful of labelled lines, written for
   * someone who will read this and nothing else. Everything here is also in
   * findings(); this is the summary that goes above it, not a second analysis.
   */
  function bottomLine(data, res, lab, fmt, fmtDate) {
    const f = fmt || ((v) => (v == null || !isFinite(v) ? "–" : "$" + v.toFixed(2)));
    const whole = (v) => (v == null || !isFinite(v) ? "–" : Math.abs(v).toFixed(0) + "%");
    const s = res.supports[0];
    const nxt = res.supports[1];
    const rows = [];

    const headline = !s
      ? `TQQQ closed at <b>${f(res.price)}</b>. <b>No floor has formed below it</b> in this window — there have not been enough swing lows to find one.`
      : s.inZone
        ? `TQQQ closed at <b>${f(res.price)}</b> and is <b>sitting on its nearest floor</b>, ${f(s.low)}–${f(s.high)}. This is the level being tested right now.`
        : `TQQQ closed at <b>${f(res.price)}</b>, about <b>${whole(s.distancePct)} above its nearest floor</b>, around ${f(s.price)}.`;

    if (s) {
      const days = Math.abs(res.price - s.price) / res.atr;
      rows.push({ label: "Nearest floor", html:
        `<b>${f(s.low)}–${f(s.high)}</b> — ${s.inZone ? "price is inside it now" : `${whole(s.distancePct)} below, roughly ${days.toFixed(0)} typical day${days < 1.5 ? "" : "s"} of movement away`}. ` +
        `Buyers have turned price higher there ${s.touches} time${s.touches > 1 ? "s" : ""}, which makes it a <b>${s.strength.toLowerCase()}</b> level.` });
    } else if (res.fallbacks.length) {
      rows.push({ label: "Nearest floor", html:
        `None confirmed. The rough guides are ${res.fallbacks.map((x) => `the ${x.label.toLowerCase()} at ${f(x.price)}`).join(" and ")} — or switch to a longer window.` });
    }

    if (s && nxt) {
      rows.push({ label: "If that breaks", html:
        `The next floor down is <b>${f(nxt.price)}</b>, a further ${whole((s.price / nxt.price - 1) * 100)} lower. Nothing in between has been defended.` });
    }

    const t = lab.trend;
    rows.push({ label: "Trend", html: `<b>${t.label}</b> — ` + {
      Uptrend: "price is above its 50 and 200-day averages and its lows keep stepping higher.",
      Downtrend: "price is below its 50 and 200-day averages and its lows keep stepping lower.",
      Mixed: "the three trend checks disagree, so the floors matter more than the trend right now.",
    }[t.label] });

    const rv = lab.rsi.value;
    const mom = rv >= 70 ? "stretched to the upside" : rv <= 30 ? "stretched to the downside"
      : rv >= 60 ? "strong, and getting stretched" : rv <= 40 ? "weak" : "neutral";
    let now = `<b>${mom.charAt(0).toUpperCase() + mom.slice(1)}</b> (RSI ${rv.toFixed(0)}, MACD ${lab.macd.label.toLowerCase()}).`;
    if (lab.bollinger.label === "Above upper band") now += " Price closed above its normal 20-day range, so a pause or pullback would be unremarkable.";
    else if (lab.bollinger.label === "Below lower band") now += " Price closed below its normal 20-day range, so a bounce would be unremarkable.";
    rows.push({ label: "Momentum", html: now });

    rows.push({ label: "Risk", html:
      `TQQQ moves about <b>${lab.atr.pct.toFixed(1)}% on a typical day</b> and targets 3× the Nasdaq-100's daily move. ` +
      `A level can be broken and reclaimed inside one session, so treat these as areas, not lines.` });

    return { headline, rows };
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
      settings: { window: res.opts.window, period: res.opts.period, clusterMult: res.opts.clusterMult, minTouches: res.opts.minTouches },
      trend: lab.trend.label, rsi: +lab.rsi.value.toFixed(1), rsi_label: lab.rsi.label,
      macd: lab.macd.label, ma_cross: lab.maCross,
      atr_pct: +lab.atr.pct.toFixed(2), drawdown: +lab.drawdown.toFixed(2),
      supports: res.supports.map(z),
      broken: res.broken.slice(0, 5).map((x) => ({ ...z(x), id: null })),
    };
  }

  /** Compare two snapshots and describe what changed. */
  function diffSnapshots(prev, cur, tolPct = 1.5) {
    const out = [];
    if (!prev) return out;
    const near = (a, b) => Math.abs(a.price / b.price - 1) * 100 <= tolPct;
    const find = (list, z) => (list || []).find((p) => near(p, z));
    const money = (v) => "$" + v.toFixed(2);

    for (const z of cur.supports) {
      if (find(prev.supports, z)) continue;
      out.push(find(prev.broken, z)
        ? { type: "reclaimed", text: `Price climbed back above ${money(z.price)}; that zone is acting as support again.` }
        : { type: "new", text: z.last_test === cur.as_of && z.touches === 1
          ? `A new support zone formed at ${money(z.price)} after today's swing low.`
          : `Support at ${money(z.price)} (${z.touches} touch${z.touches > 1 ? "es" : ""}) moved into the top ${Math.max(cur.supports.length, 1)}.` });
    }
    for (const p of prev.supports || []) {
      if (find(cur.supports, p)) continue;
      out.push(find(cur.broken, p)
        ? { type: "broken", text: `Support at ${money(p.price)} broke — price closed below the zone.` }
        : { type: "dropped", text: `Support at ${money(p.price)} dropped out of the top list.` });
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
    DEFAULTS, LIMITS, WINDOW_PRESETS, WEIGHTS, TIERS,
    normalize, strengthTier, findPivots, rollingLow, cluster, analyze, labels, trendCall, benchmark,
    volumeProfile, compareWindows, findings, bottomLine, snapshot, diffSnapshots, truncate, fromPayload,
  };
});
