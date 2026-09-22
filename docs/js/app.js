/* TQQQ dashboard — page controller: loads data, runs the method, renders the report. */
(function () {
  "use strict";
  const { StackChart, LevelDotChart, draw, withAlpha, css } = window.Charts;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const money = (v) => (v == null || !isFinite(v) ? "–" : "$" + v.toFixed(2));
  const pct = (v, d = 1, sign = true) => (v == null || !isFinite(v) ? "–" : (sign && v > 0 ? "+" : "") + v.toFixed(d) + "%");
  const compact = (v) => (v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : String(v));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtDate = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const WIN_NAMES = { 21: "1 month", 63: "3 months", 126: "6 months", 189: "9 months", 252: "12 months" };
  const winName = (w) => WIN_NAMES[w] || `${w} sessions`;
  // which optional chart panels are visible; remembered per browser
  const PANE_DEFAULTS = { vol: true, rsi: true, macd: false, dd: false, rolling: true, profile: false };
  const OVERLAYS = new Set(["rolling", "profile"]); // drawn inside the price pane, no rebuild needed

  const state = { data: null, opts: SR.normalize({}), res: null, lab: null, charts: {}, windowKey: "12m", panes: { ...PANE_DEFAULTS } };

  /* ------------------------------------------------------------ URL <-> settings */
  function readUrl() {
    const q = new URLSearchParams(location.search);
    const o = {};
    const w = q.get("window");
    if (w) {
      const k = w.toLowerCase();
      if (SR.WINDOW_PRESETS[k]) { o.window = SR.WINDOW_PRESETS[k]; state.windowKey = k; }
      else { o.window = parseInt(k, 10); state.windowKey = null; }
    }
    if (q.get("period")) o.period = q.get("period");
    if (q.get("cluster")) o.clusterMult = q.get("cluster");
    if (q.get("touches")) o.minTouches = q.get("touches");
    state.opts = SR.normalize(o);
    if (state.windowKey == null) {
      const hit = Object.entries(SR.WINDOW_PRESETS).find(([, v]) => v === state.opts.window);
      state.windowKey = hit ? hit[0] : null;
    }
    try {
      const saved = JSON.parse(localStorage.getItem("panes") || "null");
      if (saved) state.panes = { ...PANE_DEFAULTS, ...saved };
    } catch (e) { /* storage unavailable */ }
  }

  function writeUrl() {
    const o = state.opts, d = SR.DEFAULTS;
    const q = new URLSearchParams();
    q.set("window", state.windowKey || String(o.window));
    if (o.period !== d.period) q.set("period", o.period);
    if (o.clusterMult !== d.clusterMult) q.set("cluster", o.clusterMult);
    if (o.minTouches !== d.minTouches) q.set("touches", o.minTouches);
    history.replaceState(null, "", "?" + q.toString());
  }

  /* ------------------------------------------------------------ controls */
  function syncControls() {
    const o = state.opts;
    $$("#windowSeg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.w === state.windowKey)));
    const ci = $("#customWin");
    ci.classList.toggle("active", !state.windowKey);
    if (!state.windowKey) ci.value = o.window; else if (document.activeElement !== ci) ci.value = "";
    $("#period").value = o.period; $("#periodOut").textContent = o.period;
    $("#cluster").value = o.clusterMult; $("#clusterOut").textContent = o.clusterMult.toFixed(2);
    $("#touches").value = o.minTouches; $("#touchesOut").textContent = o.minTouches;
    $("#periodText").textContent = o.period;
    $$(".pv, .pv-label").forEach((el) => (el.textContent = o.period));
  }

  function bindControls() {
    $$("#windowSeg button").forEach((b) => b.addEventListener("click", () => {
      state.windowKey = b.dataset.w;
      state.opts = SR.normalize({ ...state.opts, window: SR.WINDOW_PRESETS[b.dataset.w] });
      update();
    }));
    const ci = $("#customWin");
    const applyCustom = () => {
      const v = parseInt(ci.value, 10);
      if (!isFinite(v)) return;
      state.opts = SR.normalize({ ...state.opts, window: v });
      const hit = Object.entries(SR.WINDOW_PRESETS).find(([, x]) => x === state.opts.window);
      state.windowKey = hit ? hit[0] : null;
      ci.value = state.opts.window;
      update();
    };
    ci.addEventListener("change", applyCustom);
    ci.addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustom(); });
    // arrow-key navigation inside the radio group
    $("#windowSeg").addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key) || e.target.tagName !== "BUTTON") return;
      const btns = $$("#windowSeg button");
      const i = btns.indexOf(e.target) + (e.key === "ArrowRight" ? 1 : -1);
      if (btns[i]) { btns[i].focus(); btns[i].click(); }
    });
    const slider = (id, key, parse) => $(id).addEventListener("input", (e) => {
      state.opts = SR.normalize({ ...state.opts, [key]: parse(e.target.value) });
      update({ keepView: true });
    });
    slider("#period", "period", Number);
    slider("#cluster", "clusterMult", Number);
    slider("#touches", "minTouches", Number);
    $("#resetSettings").addEventListener("click", () => {
      state.opts = SR.normalize({ window: state.opts.window });
      update({ keepView: true });
    });
    $$(".chips input[data-pane]").forEach((cb) => {
      cb.checked = !!state.panes[cb.dataset.pane];
      cb.addEventListener("change", () => {
        state.panes[cb.dataset.pane] = cb.checked;
        try { localStorage.setItem("panes", JSON.stringify(state.panes)); } catch (e) { /* storage unavailable */ }
        if (OVERLAYS.has(cb.dataset.pane)) { renderLegends(); renderCharts({ keepView: true }); }
        else rebuildMainChart();
      });
    });
    document.addEventListener("click", (e) => {
      const s = $("#settings");
      if (s.open && !s.contains(e.target)) s.open = false;
    });
    $("#themeBtn").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("theme", next); } catch (e) { /* storage unavailable */ }
      renderLegends();
      renderCharts({ keepView: true });
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderCharts({ keepView: true }));
    $$("[data-zoom]").forEach((b) => b.addEventListener("click", () => {
      const c = state.charts.main;
      if (b.dataset.zoom === "in") c.zoom(1 / 1.3);
      else if (b.dataset.zoom === "out") c.zoom(1.3);
      else c.resetView();
    }));
    $("#dlCsv").addEventListener("click", downloadCsv);
    $("#dlPng").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = state.charts.main.toPNG(`TQQQ support levels — ${winName(state.opts.window)} window — data as of ${state.data.meta.as_of}`);
      a.download = `tqqq-support-${state.data.meta.as_of}-${state.opts.window}d.png`;
      a.click();
    });
  }

  /* ------------------------------------------------------------ rendering: text */
  function renderHeader() {
    const m = state.data.meta;
    const asOf = $("#asOf");
    asOf.textContent = `Data as of ${fmtDate(m.as_of)} close`;
    // count weekdays between the data date and today (New York)
    const today = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const d = new Date(m.as_of + "T12:00:00");
    let missed = 0;
    for (const t = new Date(d); t < today; t.setDate(t.getDate() + 1)) {
      if (t.toDateString() === d.toDateString()) continue;
      const wd = t.getDay();
      if (wd !== 0 && wd !== 6) missed++;
    }
    // today's session only counts as missed after the evening refresh window
    if (today.getDay() !== 0 && today.getDay() !== 6 && today.getHours() < 19 && today.toDateString() !== d.toDateString()) missed--;
    const stale = missed > 2;
    asOf.classList.toggle("stale", stale);
    const b = $("#stale");
    // a one-session lag is usually the price source, not a broken refresh — say which
    const lag = (m.warnings || []).find((w) => /before the expected last close/.test(w));
    b.hidden = !stale && !lag;
    b.classList.toggle("info", !stale && !!lag);
    if (stale) {
      b.textContent = `Heads up: this data is ${missed} trading sessions old. The daily refresh may have failed — levels below may be out of date.`;
    } else if (lag) {
      b.textContent = "The price source has not published the most recent close yet, so this report is one session behind. "
        + "The next scheduled run picks it up.";
    }
    $("#dataMeta").textContent = `Loaded ${m.rows} sessions (${state.data.dates[0]} to ${m.as_of}) from ${m.source}; generated ${m.generated_utc.replace("T", " ").replace("Z", " UTC")}.` +
      (m.warnings && m.warnings.length ? ` Data notes: ${m.warnings.join("; ")}` : "");
  }

  function renderFindings() {
    const items = SR.findings(state.data, state.res, state.lab, money, fmtDate, { runs: state.runs });
    const groups = [];
    for (const it of items) {
      const g = groups.find((x) => x.name === it.group) || (groups.push({ name: it.group, items: [] }), groups[groups.length - 1]);
      g.items.push(it);
    }
    $("#findings").innerHTML = groups.map((g) => `<section class="fgroup">
        <h3>${esc(g.name)}</h3>
        <ul>${g.items.map((x) => `<li>${x.html}</li>`).join("")}</ul>
      </section>`).join("");
    $("#winLabel").textContent = `· ${winName(state.opts.window)} window · ${items.length} findings`;
  }

  function kpi(label, value, delta, cls = "") {
    return `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="delta">${delta}</div></div>`;
  }

  function renderKpis() {
    const d = state.data, r = state.res, l = state.lab, i = r.end;
    const chg = (d.close[i] / d.close[i - 1] - 1) * 100;
    const s = r.supports[0];
    const strongest = [...r.supports].sort((a, b) => b.score - a.score)[0];
    const fb = r.fallbacks[0];
    $("#kpis").innerHTML = [
      kpi("Last close", money(d.close[i]), `<span class="${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "▲" : "▼"} ${pct(chg, 2)}</span> on the day`),
      kpi("Trend", `<span class="pill ${l.trend.label}">${l.trend.label}</span>`,
        l.maCross ? `${l.maCross.type} ${fmtDate(l.maCross.date)}` : "50 vs 200-day"),
      s ? kpi("Nearest support", money(s.price), `${s.inZone ? "Price is in the zone" : pct(s.distancePct) + " away"} · ${s.touches} touch${s.touches > 1 ? "es" : ""}`)
        : kpi("Nearest support", fb ? money(fb.price) : "–", fb ? `Fallback: ${fb.label}` : "None in window"),
      strongest ? kpi("Strongest support", money(strongest.price), `${strongest.strength} · score ${strongest.score}/100 · ${strongest.id}`)
        : kpi("Strongest support", "–", "None in window"),
      kpi("RSI (14)", l.rsi.value.toFixed(0), l.rsi.label + ` · MACD ${l.macd.label.toLowerCase()}`),
      kpi("From 12-month high", `<span class="down">${pct(l.drawdown, 1)}</span>`, `High ${money(l.high12m)}`),
    ].join("");
  }

  function renderTable() {
    const r = state.res, d = state.data;
    const row = (z) => `<tr>
        <td><span class="lvl support">${z.id}</span></td>
        <td class="num"><b>${money(z.price)}</b></td>
        <td class="num">${z.high - z.low < 0.005 ? '<span class="muted">single low</span>' : `${money(z.low)}–${money(z.high).slice(1)}`}</td>
        <td class="num">${z.inZone ? "in zone" : pct(z.distancePct)}</td>
        <td class="num">${z.touches}</td>
        <td>${fmtDate(z.date)}</td>
        <td class="strength"><span class="bar" aria-hidden="true"><i class="t${z.strength}" style="width:${z.score}%"></i></span><span class="tier">${z.strength}</span> <span class="muted">${z.score}</span></td>
        <td><span class="status ${z.status.replace(/ /g, "-")}">${z.status}</span>${z.brokeBefore ? '<span class="sub-cell">broke once before</span>' : ""}</td>
      </tr>`;
    const sup = r.supports; // already nearest-first
    let html = `<tr class="price-row"><td>Last close</td><td class="num">${money(r.price)}</td><td class="num muted">ATR ${money(r.atr)}</td><td colspan="5" class="muted">${d.dates[r.end]} · zones are ${money(r.tol)} wide (${r.opts.clusterMult} × ATR)</td></tr>`;
    html += sup.length ? sup.map(row).join("")
      : `<tr><td colspan="8" class="muted">No confirmed support zone in a ${winName(r.opts.window)} window — price has not put in enough swing lows. Try a longer window.</td></tr>`;
    if (r.fallbacks.length) {
      html += r.fallbacks.map((f) => `<tr><td><span class="lvl fallback">Fallback</span></td><td class="num">${money(f.price)}</td><td colspan="6" class="muted">${f.label} — shown because this window has fewer than two confirmed support zones.</td></tr>`).join("");
    }
    if (r.broken.length) {
      const list = r.broken.slice(-3).reverse().map((z) => money(z.price)).join(", ");
      html += `<tr class="foot-row"><td colspan="8" class="muted">${r.broken.length} zone${r.broken.length > 1 ? "s" : ""} in this window broke (price closed below ${list}) and ${r.broken.length > 1 ? "are" : "is"} no longer counted as support.</td></tr>`;
    }
    $("#levels tbody").innerHTML = html;
  }

  function renderIndicators() {
    const d = state.data, l = state.lab, i = state.res.end;
    const c = d.close[i];
    const t = l.trend;
    const sign = (v) => (v > 0 ? "above" : "below");
    const rows = [
      ["Moving averages", "20 / 50 / 200-day simple", `${money(d.sma20[i])} / ${money(d.sma50[i])} / ${money(d.sma200[i])}`,
        `<span class="pill ${t.label}">${t.label}</span>`,
        `Price is ${sign(c - d.sma50[i])} the 50-day and ${sign(c - d.sma200[i])} the 200-day; the 50-day is ${t.slopePct >= 0 ? "rising" : "falling"} (${pct(t.slopePct)} over 20 sessions)${l.maCross ? `. Last ${l.maCross.type.toLowerCase()}: ${fmtDate(l.maCross.date)}` : ""}.`],
      ["RSI", "14-day", l.rsi.value.toFixed(1), l.rsi.label,
        "Above 70 means the recent rise is stretched; below 30 means the fall is stretched. Support tends to hold better when RSI is already low."],
      ["MACD", "12, 26, 9", `${l.macd.value.toFixed(2)} / ${l.macd.signal.toFixed(2)}`, `${l.macd.label}${l.macd.crossDate ? ` since ${fmtDate(l.macd.crossDate)}` : ""}`,
        `Momentum is ${l.macd.hist >= 0 ? "building" : "fading"}: the MACD line is ${l.macd.hist >= 0 ? "above" : "below"} its signal line.`],
      ["Bollinger Bands", "20-day, 2 std dev", `${money(d.bb_lower[i])} – ${money(d.bb_upper[i])}`, l.bollinger.label,
        `Price sits at ${(l.bollinger.position * 100).toFixed(0)}% of its normal 20-day range (0% = lower band, 100% = upper band).`],
      ["ATR", "14-day", `${money(l.atr.value)} (${l.atr.pct.toFixed(1)}%)`, `Moves about ${l.atr.pct.toFixed(1)}% a day`,
        "The typical daily range. It sets how wide the support zones are and how far below a level a stop would sit."],
      ["Volume vs. average", "20-day average", `${compact(d.volume[i])} vs ${compact(d.vol_avg20[i])}`, l.volume.label,
        "Heavy volume at a support test suggests real buying behind the bounce."],
    ];
    $("#indTable tbody").innerHTML = rows.map((r) => `<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td class="num">${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td></tr>`).join("");
  }

  function renderChanges(ch) {
    const ul = $("#changes");
    if (!ch || !ch.items) { ul.innerHTML = `<li class="muted">No comparison available yet.</li>`; return; }
    const tags = { new: "New", broken: "Broken", reclaimed: "Reclaimed", dropped: "Dropped", trend: "Trend", rsi: "RSI", macd: "MACD", cross: "Cross" };
    ul.innerHTML = ch.items.length
      ? ch.items.map((x) => `<li><span class="tag ${x.type}">${tags[x.type] || x.type}</span><span>${esc(x.text)}</span></li>`).join("")
      : `<li class="muted">No changes to the support levels, trend or momentum labels.</li>`;
    $("#changesNote").textContent = ch.previous
      ? `${fmtDate(ch.as_of)} compared with ${fmtDate(ch.previous)}, using the default settings (12-month window, 3-day swings). Levels within 1.5% of each other count as the same level.`
      : "";
  }

  /* ------------------------------------------------------------ rendering: charts */
  function legend(el, items) {
    el.innerHTML = items.map(([cls, style, label]) => `<li><span class="key ${cls}" style="${style}"></span>${label}</li>`).join("");
  }

  function mainTooltip(i) {
    const d = state.data;
    const chg = i > 0 ? (d.close[i] / d.close[i - 1] - 1) * 100 : 0;
    const sw = (v) => `<span class="sw" style="background:${css(v)}"></span>`;
    const pivots = state.res.pivots;
    const tags = [];
    if (pivots.lows.includes(i)) tags.push("Swing low");
    if (pivots.pendingLows.includes(i)) tags.push("Pending swing low");
    const zone = state.res.supports.find((z) => d.low[i] <= z.high + state.res.tol / 2 && d.high[i] >= z.low - state.res.tol / 2);
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    return `<div class="d">${fmtDate(d.dates[i])}${tags.length ? ` · ${tags.join(", ")}` : ""}</div><table>
      ${row("Open / Close", `${money(d.open[i])} / ${money(d.close[i])}`)}
      ${row("High / Low", `${money(d.high[i])} / ${money(d.low[i])}`)}
      ${row("Change", `<span class="${chg >= 0 ? "up" : "down"}">${pct(chg, 2)}</span>`)}
      ${zone ? row(`${sw("--support")}In support zone`, `${zone.id} ${money(zone.price)}`) : ""}
      ${row(`${sw("--rolling")}${state.opts.period}-day low`, money(state.res.rollingLow[i]))}
      ${row(`${sw("--sma20")}20 / ${sw("--sma50")}50 / ${sw("--sma200")}200-day`, `${money(d.sma20[i])} / ${money(d.sma50[i])} / ${money(d.sma200[i])}`)}
      ${row("Volume", `${compact(d.volume[i])} (${(d.volume[i] / d.vol_avg20[i]).toFixed(1)}× avg)`)}
      ${row("RSI", d.rsi14[i]?.toFixed(1) ?? "–")}
      ${row("MACD / signal", d.macd[i] != null ? `${d.macd[i].toFixed(2)} / ${d.macd_signal[i].toFixed(2)}` : "–")}
      ${row("Below 12-month high", pct(d.drawdown[i], 1))}
    </table>`;
  }

  function buildMainChart() {
    const d = state.data;
    const extent = (keys) => (a, b) => {
      let mn = Infinity, mx = -Infinity;
      for (const k of keys) for (let i = a; i <= b; i++) { const v = d[k][i]; if (v != null) { if (v < mn) mn = v; if (v > mx) mx = v; } }
      return [mn, mx];
    };
    const optional = {
      vol: {
        id: "vol", title: "Volume", height: 84, mobileHeight: 60, fixed: true, padY: 0,
        format: compact, ticks: (lo, hi) => [hi * 0.5],
        range: (a, b) => [0, extent(["volume"])(a, b)[1] * 1.05],
        draw: (ctx, S) => {
          const lows = new Set(state.res.pivots.lows);
          draw.bars(ctx, S, d.volume, (i) => (lows.has(i) ? css("--support") : css("--vol")));
          draw.line(ctx, S, d.vol_avg20, css("--sma20"), 1.5);
        },
      },
      rsi: {
        id: "rsi", title: "RSI (14) — over 70 stretched up, under 30 stretched down", height: 84, mobileHeight: 60, fixed: true,
        format: (v) => v.toFixed(0), ticks: () => [30, 50, 70],
        range: () => [0, 100],
        draw: (ctx, S) => {
          draw.hband(ctx, S, 70, 100, withAlpha(css("--danger"), 0.08));
          draw.hband(ctx, S, 0, 30, withAlpha(css("--support"), 0.08));
          draw.line(ctx, S, d.rsi14, css("--sma20"), 1.5);
        },
      },
      macd: {
        id: "macd", title: "MACD (12, 26, 9) — momentum", height: 96, mobileHeight: 68, format: (v) => v.toFixed(1),
        range: (a, b) => { const [mn, mx] = extent(["macd", "macd_signal", "macd_hist"])(a, b); const m = Math.max(Math.abs(mn), Math.abs(mx)); return [-m, m]; },
        draw: (ctx, S) => {
          draw.bars(ctx, S, d.macd_hist, (i, v) => withAlpha(css(v >= 0 ? "--support" : "--danger"), 0.55));
          draw.line(ctx, S, d.macd, css("--sma20"), 1.5);
          draw.line(ctx, S, d.macd_signal, css("--sma50"), 1.5);
        },
      },
      dd: {
        id: "dd", title: "% below the 12-month high", height: 78, mobileHeight: 58, fixed: true,
        format: (v) => v.toFixed(0) + "%",
        range: (a, b) => [Math.min(-5, extent(["drawdown"])(a, b)[0] * 1.08), 0],
        draw: (ctx, S) => {
          draw.area(ctx, S, d.drawdown, 0, withAlpha(css("--danger"), 0.12));
          draw.line(ctx, S, d.drawdown, css("--danger"), 1.5);
        },
      },
    };
    const panes = [
      {
        id: "price", height: 460, mobileHeight: 320, padY: 0.09, format: (v) => "$" + (v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)),
        range: (a, b) => extent(["low", "high"])(a, b),
        draw: drawPricePane,
      },
      ...Object.keys(optional).filter((k) => state.panes[k]).map((k) => optional[k]),
    ];
    panes[panes.length - 1].gap = 0;
    const c = new StackChart($("#mainChart"), {
      panes, dates: d.dates, tooltip: mainTooltip, rightPad: 4,
      dimBefore: () => state.res.start,
    });
    c.canvas.setAttribute("aria-label", "Candlestick chart of TQQQ with shaded support zones and optional volume, RSI, MACD and drawdown panels. The levels table below lists the same zones.");
    return c;
  }

  function rebuildMainChart() {
    const old = state.charts.main;
    const view = old && old.view;
    old && old.destroy();
    state.charts.main = buildMainChart();
    const end = state.data.dates.length - 1;
    if (view) state.charts.main.setView(view.from, view.to, [0, end]);
    else renderCharts();
  }

  function drawPricePane(ctx, S) {
    const d = state.data, r = state.res;
    const sup = css("--support");
    const half = r.tol / 2;
    // 1. optional volume-by-price profile, drawn behind everything on the right
    if (state.panes.profile) {
      const prof = SR.volumeProfile(d, r, 32);
      const maxV = Math.max(...prof.map((p) => p.volume));
      const profW = (S.right - S.left) * (S.mobile ? 0.16 : 0.12);
      ctx.fillStyle = withAlpha(css("--text-muted"), 0.18);
      for (const p of prof) {
        const y1 = S.y(p.high), y2 = S.y(p.low);
        const w = (p.volume / maxV) * profW;
        ctx.fillRect(S.right - w, y1 + 1, w, Math.max(1, y2 - y1 - 2));
      }
    }
    // 2. support zones: full-width bands, opacity stepped by strength so the
    //    strong ones read at a glance instead of blending into each other
    const labels = [];
    const alphaFor = { Strong: 0.22, Moderate: 0.13, Weak: 0.07 };
    for (const z of r.supports) {
      const y1 = S.y(z.high + half), y2 = S.y(z.low - half);
      const h = Math.max(4, y2 - y1);
      ctx.fillStyle = withAlpha(sup, alphaFor[z.strength]);
      ctx.fillRect(S.left, y1, S.right - S.left, h);
      // centre line at the zone price
      ctx.strokeStyle = withAlpha(sup, 0.85);
      ctx.lineWidth = z.strength === "Strong" ? 2 : 1.25;
      const ym = Math.round(S.y(z.price)) + 0.5;
      ctx.beginPath(); ctx.moveTo(S.left, ym); ctx.lineTo(S.right, ym); ctx.stroke();
      labels.push({ y: S.y(z.price), text: `${z.id} ${money(z.price)}`, col: sup });
    }
    // fallback levels for thin windows
    r.fallbacks.forEach((f) => {
      draw.hline(ctx, S, f.price, sup, [2, 3], 1.25);
      labels.push({ y: S.y(f.price), text: money(f.price), col: sup });
    });
    // 3. moving averages & rolling low (the 20-day is thinner: it is context, not a level)
    draw.line(ctx, S, d.sma200, css("--sma200"), 2);
    draw.line(ctx, S, d.sma50, css("--sma50"), 2);
    draw.line(ctx, S, d.sma20, css("--sma20"), 1.25);
    if (state.panes.rolling) {
      draw.step(ctx, S, r.rollingLow.map((v, i) => (i >= r.start ? v : null)), withAlpha(css("--rolling"), 0.75), 1.25);
    }
    // 4. candles
    draw.candles(ctx, S, d, css("--candle"), css("--candle"));
    // 5. swing-low markers
    const off = Math.max(8, S.barW * 0.3 + 6);
    const size = S.mobile ? 4 : 4.5;
    const used = new Set(r.supports.flatMap((z) => z.pivots)); // lows that built one of S1…S5
    r.pivots.lows.forEach((i) => draw.triangle(ctx, S.x(i), S.y(d.low[i]) + off, "up",
      used.has(i) ? sup : withAlpha(sup, 0.34), false, used.has(i) ? size : size - 1));
    r.pivots.pendingLows.forEach((i) => draw.triangle(ctx, S.x(i), S.y(d.low[i]) + off, "up", sup, true, size));
    // 6. window start marker
    if (r.start > S.i0) {
      const x = Math.round(S.x(r.start) - S.barW / 2) + 0.5;
      ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, S.top); ctx.lineTo(x, S.bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = css("--text-muted"); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("window starts", x + 4, S.top + 3);
    }
    // 7. labels on the right edge, de-overlapped, plus the last price tag
    labels.push({ y: S.y(r.price), text: money(r.price), col: css("--text-primary"), last: true });
    labels.sort((a, b) => a.y - b.y);
    for (let k = 1; k < labels.length; k++) if (labels[k].y - labels[k - 1].y < 17) labels[k].y = labels[k - 1].y + 17;
    const over = labels.length ? labels[labels.length - 1].y - (S.bottom - 9) : 0;
    if (over > 0) labels.forEach((l) => (l.y -= over));
    for (const l of labels) draw.tag(ctx, S.right - 2, l.y, l.text, l.col, l.last ? css("--surface-1") : "#fff");
  }

  function buildBenchChart() {
    const d = state.data;
    const idx = { t: [], q: [] };
    const recompute = () => {
      const s = state.res.start;
      idx.t = d.close.map((v, i) => (i >= s ? (v / d.close[s]) * 100 : null));
      idx.q = d.qqq_close.map((v, i) => (i >= s ? (v / d.qqq_close[s]) * 100 : null));
    };
    const c = new StackChart($("#benchChart"), {
      dates: d.dates, rightPad: 1, minBars: 10,
      panes: [{
        id: "b", height: 240, mobileHeight: 200, gap: 0, format: (v) => v.toFixed(0),
        range: (a, b) => {
          const vals = [...idx.t.slice(a, b + 1), ...idx.q.slice(a, b + 1)].filter((v) => v != null);
          return [Math.min(...vals), Math.max(...vals)];
        },
        draw: (ctx, S) => {
          draw.hline(ctx, S, 100, css("--axis"));
          draw.line(ctx, S, idx.q, css("--qqq"), 2);
          draw.line(ctx, S, idx.t, css("--accent"), 2);
          const e = S.i1;
          for (const [arr, col] of [[idx.t, css("--accent")], [idx.q, css("--qqq")]]) {
            ctx.beginPath(); ctx.arc(S.x(e), S.y(arr[e]), 4, 0, Math.PI * 2);
            ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = css("--surface-1"); ctx.lineWidth = 2; ctx.stroke();
          }
        },
      }],
      tooltip: (i) => `<div class="d">${fmtDate(d.dates[i])}</div><table>
        <tr><td><span class="sw" style="background:${css("--accent")}"></span>TQQQ</td><td>${idx.t[i] != null ? "$" + idx.t[i].toFixed(1) : "–"}</td></tr>
        <tr><td><span class="sw" style="background:${css("--qqq")}"></span>QQQ</td><td>${idx.q[i] != null ? "$" + idx.q[i].toFixed(1) : "–"}</td></tr></table>`,
    });
    c.canvas.setAttribute("aria-label", "Line chart comparing growth of $100 in TQQQ and QQQ over the selected window.");
    c.recompute = recompute;
    return c;
  }

  function renderBenchStats() {
    const b = SR.benchmark(state.data, state.res);
    $("#benchStats").innerHTML = `
      <div><b>${pct(b.tqqqReturn)}</b><span>TQQQ return</span></div>
      <div><b>${pct(b.qqqReturn)}</b><span>QQQ return (3× = ${pct(b.naive3x, 0)})</span></div>
      <div><b>${b.beta.toFixed(2)}×</b><span>Daily beta to QQQ</span></div>
      <div><b>${b.volTqqq.toFixed(0)}% / ${b.volQqq.toFixed(0)}%</b><span>Annualised volatility</span></div>`;
  }

  function renderCompare() {
    const runs = state.runs;
    if (!state.charts.cmp) {
      state.charts.cmp = new LevelDotChart($("#cmpChart"), {
        onHoverText: (z, w) => `<div class="d">Support ${money(z.price)}</div><table>
          <tr><td>Window</td><td>${winName(w)}</td></tr>
          <tr><td>Zone range</td><td>${money(z.low)}–${money(z.high)}</td></tr>
          <tr><td>Times held</td><td>${z.touches}</td></tr>
          <tr><td>Strength</td><td>${z.strength} (${z.score})</td></tr>
          <tr><td>Found in</td><td>${z.windowsSeen} of 4 windows</td></tr></table>`,
      });
      state.charts.cmp.canvas.setAttribute("aria-label", "Dot chart of the top support levels for 1, 3, 6 and 12-month windows.");
    }
    state.charts.cmp.setData(runs, state.res.price, money);
    // summary: recurring levels, deduplicated
    const seen = [];
    for (const r of runs) for (const z of r.res.supports) {
      if (z.windowsSeen >= 3 && !seen.some((s) => Math.abs(s.price - z.price) <= state.res.tol)) seen.push(z);
    }
    seen.sort((a, b) => b.price - a.price);
    $("#cmpSummary").innerHTML = seen.length
      ? `Found in 3 or more windows: ${seen.map((z) => `<b>${money(z.price)}</b>`).join(", ")}. These are the most dependable floors on the chart.`
      : "No level appears in 3 or more windows right now — treat the levels below as specific to the window you picked.";
  }

  function renderCharts({ keepView } = {}) {
    const r = state.res, d = state.data;
    const main = state.charts.main;
    const end = d.dates.length - 1;
    // the chart shows the window (plus a little context); users can pan back to the full 2 years
    const lead = Math.round(r.opts.window * 0.06);
    const from = Math.max(0, r.start - lead);
    if (keepView && main.view) main.render(); else main.setView(from, end, [0, end]);
    const b = state.charts.bench;
    b.recompute();
    b.setView(r.start, end, [r.start, end]);
    state.charts.cmp && state.charts.cmp.render();
  }

  function renderLegends() {
    legend($("#legend"), [
      ["box strong", `background:${withAlpha(css("--support"), 0.30)};border:1px solid ${css("--support")}`, "Support zone (darker = stronger)"],
      ["tri", `border-bottom-color:${css("--support")}`, "Swing low that built a level"],
      ["tri faint", `border-bottom-color:${css("--support")}`, "Other swing low"],
      ["tri hollow", `border-bottom-color:${css("--support")}`, "Pending (not yet confirmed)"],
      ["candle", "", "Up day"], ["candle fill", "", "Down day"],
      ...(state.panes.rolling ? [["", `border-color:${css("--rolling")}`, `${state.opts.period}-day rolling low`]] : []),
      ["", `border-color:${css("--sma20")}`, "20-day avg"], ["", `border-color:${css("--sma50")}`, "50-day avg"],
      ["", `border-color:${css("--sma200")}`, "200-day avg"],
    ]);
    legend($("#cmpLegend"), [
      ["dot", `background:${css("--support")}`, "Support level (size = strength)"],
      ["dot ring", `border-color:${css("--support")}`, "Found in 3+ windows"],
      ["dash", `border-color:${css("--text-secondary")}`, "Last close"],
    ]);
    legend($("#benchLegend"), [["", `border-color:${css("--accent")}`, "TQQQ"], ["", `border-color:${css("--qqq")}`, "QQQ"]]);
  }

  /* ------------------------------------------------------------ downloads */
  function downloadCsv() {
    const r = state.res, d = state.data;
    const lines = [
      `# TQQQ support levels, data as of ${d.meta.as_of}, window ${r.opts.window} sessions, swing period ${r.opts.period}, cluster ${r.opts.clusterMult}xATR, min touches ${r.opts.minTouches}`,
      "level,zone_price,zone_low,zone_high,distance_pct,touches,last_test,first_seen,strength_score,strength,status,volume_vs_avg",
      ...r.supports.map((z) => [z.id, z.price.toFixed(2), z.low.toFixed(2), z.high.toFixed(2),
        z.distancePct.toFixed(2), z.touches, z.date, z.firstDate, z.score, z.strength, z.status, z.volumeRatio.toFixed(2)].join(",")),
      "",
      "date,open,high,low,close,volume,rolling_low,sma20,sma50,sma200,rsi14,macd,macd_signal,bb_upper,bb_lower,atr14,drawdown_pct,swing_low",
    ];
    const lows = new Set(r.pivots.lows);
    const f = (v, n = 4) => (v == null ? "" : (+v).toFixed(n));
    for (let i = r.start; i <= r.end; i++) {
      lines.push([d.dates[i], f(d.open[i]), f(d.high[i]), f(d.low[i]), f(d.close[i]), d.volume[i], f(r.rollingLow[i]),
        f(d.sma20[i]), f(d.sma50[i]), f(d.sma200[i]), f(d.rsi14[i], 2), f(d.macd[i]), f(d.macd_signal[i]),
        f(d.bb_upper[i]), f(d.bb_lower[i]), f(d.atr14[i]), f(d.drawdown[i], 2),
        lows.has(i) ? "yes" : ""].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tqqq-support-${d.meta.as_of}-${r.opts.window}d.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ------------------------------------------------------------ main loop */
  function update({ keepView = false } = {}) {
    state.res = SR.analyze(state.data, state.opts);
    state.lab = SR.labels(state.data, state.res);
    state.runs = SR.compareWindows(state.data, state.opts); // shared by the findings and the window chart
    syncControls();
    writeUrl();
    renderFindings();
    renderKpis();
    renderTable();
    renderIndicators();
    renderLegends();
    renderBenchStats();
    renderCompare();
    renderCharts({ keepView });
    document.title = `TQQQ Support Levels · ${money(state.res.price)} · ${state.data.meta.as_of}`;
  }

  async function init() {
    readUrl();
    bindControls();
    try {
      const bust = "?v=" + Math.floor(Date.now() / 3.6e6); // refresh at least hourly past the CDN cache
      const [payload, changes] = await Promise.all([
        fetch("data/tqqq.json" + bust).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch("data/changes.json" + bust).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      state.data = SR.fromPayload(payload);
      renderHeader();
      renderChanges(changes);
      state.charts.main = buildMainChart();
      state.charts.bench = buildBenchChart();
      update();
    } catch (e) {
      console.error(e);
      $("#findings").innerHTML = `<li>Could not load the data file (${esc(e.message)}). Please try again later.</li>`;
      $("#asOf").textContent = "Data unavailable";
    }
  }

  init();
})();
