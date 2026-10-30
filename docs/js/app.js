/* Support levels dashboard — page controller: loads a ticker's data, runs the method, renders the report. */
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
  const PANE_DEFAULTS = { vol: true, rsi: true, macd: false, dd: false, rolling: true, profile: false, above: true, bb: true,
    zones: true, sma20: true, sma50: true, sma200: true, swings: true };
  // "Simple view": candles, the support below the price and the 50 and 200-day averages
  const SIMPLE_VIEW = { ...Object.fromEntries(Object.keys(PANE_DEFAULTS).map((k) => [k, false])), zones: true, sma50: true, sma200: true };
  // The page finds levels over at least this many sessions, whatever the window, and
  // lists every level it finds rather than the strongest five on each side.
  const analyze = () => SR.analyze(state.data, { ...state.opts, minLookback: SR.LEVEL_SESSIONS, topN: Infinity, topAbove: Infinity });
  const OVERLAYS = new Set(["rolling", "profile", "above", "bb", "zones", "sma20", "sma50", "sma200", "swings"]); // drawn inside the price pane, no rebuild needed

  // the window the page opens on: SR.PAGE_SETTINGS, which the nightly snapshot and
  // "What changed" also use, so they describe the levels shown when the page opens
  const PAGE_WINDOW = "1m";
  const state = { data: null, opts: SR.normalize({ window: SR.WINDOW_PRESETS[PAGE_WINDOW] }), res: null, lab: null, charts: {}, windowKey: PAGE_WINDOW,
    panes: { ...PANE_DEFAULTS }, cadence: "daily", view: null };
  // the browser tests read the page's state; only exposed when a test drives the browser
  if (navigator.webdriver) window.__dashboard = state;

  /* ------------------------------------------------------------ URL <-> settings */
  const SETTING_KEYS = ["window", "period", "cluster", "touches"];
  // used only if the ticker list (data/tickers.json) cannot be read
  const FALLBACK_LIST = { default: "TQQQ", tickers: [{ symbol: "TQQQ", name: "ProShares UltraPro QQQ", index: "Nasdaq-100", leverage: 3, benchmark: "QQQ", dir: "data" }] };

  function readUrl() {
    // a link that carries settings wins; otherwise reopen with this browser's last ones.
    // The ticker and the chart layers in a link always win, even when it carries nothing else.
    const url = new URLSearchParams(location.search);
    let q = url;
    if (!SETTING_KEYS.some((k) => url.has(k))) {
      try { q = new URLSearchParams(localStorage.getItem("settings") || ""); } catch (e) { /* storage unavailable */ }
    }
    const pick = (k) => (url.has(k) ? url.get(k) : q.get(k));
    const o = { window: SR.WINDOW_PRESETS[PAGE_WINDOW] };
    const w = q.get("window");
    if (w) {
      const k = w.toLowerCase();
      if (SR.WINDOW_PRESETS[k]) { o.window = SR.WINDOW_PRESETS[k]; state.windowKey = k; }
      else { o.window = parseInt(k, 10); state.windowKey = null; }
    }
    // ?show=zones,sma50,... names exactly the chart layers to show (written when they differ from the defaults)
    if (pick("show") != null) {
      const on = new Set(pick("show").split(",").filter((k) => k in PANE_DEFAULTS));
      state.panes = Object.fromEntries(Object.keys(PANE_DEFAULTS).map((k) => [k, on.has(k)]));
      state.panesFromLink = true;
    }
    state.requestedTicker = (pick("ticker") || "").trim().toUpperCase() || null;
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
      if (saved && !state.panesFromLink) state.panes = { ...PANE_DEFAULTS, ...saved };
      if (localStorage.getItem("cadence") === "weekly") state.cadence = "weekly";
    } catch (e) { /* storage unavailable */ }
  }

  // Safari stops a page that changes its address more than 100 times in 10 seconds (dragging
  // a slider can), so the address is written at most once every URL_GAP ms, the last one kept
  const URL_GAP = 250;
  let urlTimer = null, lastUrlWrite = 0;
  function writeUrl({ now = false } = {}) {
    const o = state.opts, d = SR.DEFAULTS;
    const q = new URLSearchParams();
    if (state.ticker && state.listing && state.ticker.symbol !== state.listing.default) q.set("ticker", state.ticker.symbol);
    q.set("window", state.windowKey || String(o.window));
    if (o.period !== d.period) q.set("period", o.period);
    if (o.clusterMult !== d.clusterMult) q.set("cluster", o.clusterMult);
    if (o.minTouches !== d.minTouches) q.set("touches", o.minTouches);
    const shown = Object.keys(PANE_DEFAULTS).filter((k) => state.panes[k]);
    if (Object.keys(PANE_DEFAULTS).some((k) => !!state.panes[k] !== PANE_DEFAULTS[k])) q.set("show", shown.join(",") || "none");
    try { localStorage.setItem("settings", q.toString()); } catch (e) { /* storage unavailable */ }
    const write = () => {
      urlTimer = null;
      lastUrlWrite = Date.now();
      try { history.replaceState(null, "", "?" + q.toString()); } catch (e) { /* refused: the next change writes it */ }
    };
    clearTimeout(urlTimer);
    const wait = now ? 0 : URL_GAP - (Date.now() - lastUrlWrite);
    if (wait <= 0) write();
    else urlTimer = setTimeout(write, wait);
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
    $$("#cadenceSeg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.cadence === state.cadence)));
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
    const det = $("#allFindings");
    try { det.open = localStorage.getItem("findingsOpen") === "1"; } catch (e) { /* storage unavailable */ }
    det.addEventListener("toggle", () => {
      try { localStorage.setItem("findingsOpen", det.open ? "1" : "0"); } catch (e) { /* storage unavailable */ }
    });
    const applyPanes = (next) => {
      const panelsChanged = Object.keys(PANE_DEFAULTS).some((k) => !OVERLAYS.has(k) && !!next[k] !== !!state.panes[k]);
      state.panes = { ...next };
      try { localStorage.setItem("panes", JSON.stringify(state.panes)); } catch (e) { /* storage unavailable */ }
      $$(".chips input[data-pane]").forEach((cb) => (cb.checked = !!state.panes[cb.dataset.pane]));
      // at once, not on the usual delay: a reload reads ?show= back, and a reload can
      // land inside that delay, in which case the stale address would undo the switch
      writeUrl({ now: true });
      if (panelsChanged) rebuildMainChart(); else { renderLegends(); renderCharts({ keepView: true }); }
    };
    $$(".chips input[data-pane]").forEach((cb) => {
      cb.checked = !!state.panes[cb.dataset.pane];
      cb.addEventListener("change", () => applyPanes({ ...state.panes, [cb.dataset.pane]: cb.checked }));
    });
    $("#simpleView").addEventListener("click", () => applyPanes(SIMPLE_VIEW));
    $("#showAll").addEventListener("click", () => applyPanes(Object.fromEntries(Object.keys(PANE_DEFAULTS).map((k) => [k, true]))));
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
    $("#resetZoom").addEventListener("click", () => state.charts.main.resetView());
    $("#zoomIn").addEventListener("click", () => state.charts.main.zoom(1 / 1.25));
    $("#zoomOut").addEventListener("click", () => state.charts.main.zoom(1.25));
    $$("#cadenceSeg button").forEach((b) => b.addEventListener("click", () => {
      if (state.cadence === b.dataset.cadence) return;
      state.cadence = b.dataset.cadence;
      try { localStorage.setItem("cadence", state.cadence); } catch (e) { /* storage unavailable */ }
      syncControls();
      rebuildMainChart({ resetView: true }); // bar count changes, so the old view no longer maps
    }));
    $("#dlCsv").addEventListener("click", downloadCsv);
    $("#dlPng").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = state.charts.main.toPNG(`${tk().symbol} support levels — ${winName(state.opts.window)} window — data as of ${state.data.meta.as_of}`);
      a.download = `${tk().symbol.toLowerCase()}-support-${state.data.meta.as_of}-${state.opts.window}d.png`;
      a.click();
    });
  }

  /* ------------------------------------------------------------ rendering: text */
  function renderHeader() {
    const m = state.data.meta;
    const asOf = $("#asOf");
    // New York wall clock: the market's day, not the reader's
    const nowNY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const fr = SR.freshness(m.as_of, nowNY);
    asOf.textContent = `Data as of ${fmtDate(m.as_of)} close` + (fr.state === "pending" ? " · update pending" : "");
    asOf.classList.toggle("stale", fr.state === "stale");
    asOf.classList.toggle("pending", fr.state === "pending");

    const b = $("#stale");
    const lag = (m.warnings || []).find((w) => /before the expected last close/.test(w));
    b.hidden = fr.state === "current";
    b.classList.toggle("info", fr.state === "pending");
    if (fr.state === "stale") {
      const missing = fr.behind === 1 ? `the ${fmtDate(fr.expected)} close` : `${fr.behind} trading days, up to the ${fmtDate(fr.expected)} close`;
      b.textContent = `Out of date: this report is missing ${missing}. The daily refresh may have failed, so the levels below may be out of date.`
        + (lag ? " The price source had not published the latest close when the last run went." : "");
    } else if (fr.state === "pending") {
      // the common case: the market has closed but tonight's run has not gone yet
      b.textContent = "Today's session has closed. This report rebuilds after the close, so today's figures usually appear within a few hours. "
        + `Until then you are looking at the ${fmtDate(m.as_of)} close.`;
    }
    $("#dataMeta").textContent = `Loaded ${m.rows} sessions (${state.data.dates[0]} to ${m.as_of}) from ${m.source}; generated ${m.generated_utc.replace("T", " ").replace("Z", " UTC")}.` +
      (m.warnings && m.warnings.length ? ` Data notes: ${m.warnings.join("; ")}` : "");
  }

  function renderBottomLine() {
    const bl = SR.bottomLine(state.data, state.res, state.lab, money, fmtDate);
    const head = $("#blHeadline");
    head.innerHTML = bl.headline;
    head.classList.remove("skeleton");
    $("#blRows").innerHTML = bl.rows
      .map((r) => `<div><dt>${esc(r.label)}</dt><dd>${r.html}</dd></div>`).join("") +
      `<div id="blChanges"><dt>Since the previous session</dt><dd><ul id="changes" class="changes"></ul><p class="help" id="changesNote"></p></dd></div>`;
    renderChanges();
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
    $("#winLabel").textContent = `· ${winName(state.opts.window)} window`;
    $("#findingsSummary").textContent = `All ${items.length} findings`;
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
      kpi(`Last close · ${shortDate(d.dates[i])}`, money(d.close[i]), `<span class="${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "▲" : "▼"} ${pct(chg, 2)}</span> on the day${extHoursLine(d.dates[d.dates.length - 1])}`),
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

  /* ------------------------------------------- pre-market and after-hours price */
  const EXT_LABEL = { pre: "Pre-market", post: "After hours" };

  const shortDate = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  /**
   * The line under "Last close" while pre-market or after-hours trading is on (from /quote).
   * The change is from the newest regular close. Each weekday the report is rebuilt a few
   * hours after the close, so during after hours that close is often newer than the report's
   * own: it is then shown, and said to be missing from the report, so the two prices on the
   * card are not read as one day's.
   */
  function extHoursLine(reportDate) {
    const q = state.quote;
    if (!q || q.status !== "ok" || !EXT_LABEL[q.session]) return "";
    const price = Number(q.price), change = Number(q.changePct), at = new Date(q.time);
    if (!isFinite(price) || !isFinite(change) || isNaN(at)) return "";
    const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).replace("AM", "am").replace("PM", "pm");
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(q.closeDate);
    const close = Number(q.close);
    const newer = dated && reportDate && q.closeDate > reportDate && isFinite(close);
    const from = newer ? `the ${shortDate(q.closeDate)} close of ${money(close)}, which this report does not include yet`
      : dated ? `the ${shortDate(q.closeDate)} close` : "the last close";
    return `<div class="ext" id="extHours"><b>${EXT_LABEL[q.session]} ${money(price)}</b> ` +
      `<span class="${change >= 0 ? "up" : "down"}">${change >= 0 ? "▲" : "▼"} ${pct(change, 2)}</span><br>` +
      `from ${from} · ${time} New York time</div>`;
  }

  /**
   * Ask the lookup service for the pre-market or after-hours price, and ask again when it
   * says to: every minute during those hours, else when they next start. Nothing is shown
   * when the service is not set up or cannot be reached; the rest of the page is unaffected.
   */
  async function pollQuote() {
    if (!state.listing || !state.listing.proxy) return;
    let next = 300;
    if (document.hidden) next = 60; // a tab in the background asks nothing
    else {
      try {
        const r = await fetch(`${state.listing.proxy}/quote?symbol=${encodeURIComponent(tk().symbol)}`);
        const q = await r.json();
        state.quote = r.ok ? q : null;
        if (r.ok && isFinite(q.next)) next = Math.min(3600, Math.max(5, Number(q.next)));
      } catch (e) {
        state.quote = null;
      }
      renderKpis();
    }
    setTimeout(pollQuote, next * 1000);
  }

  function renderTable() {
    const r = state.res, d = state.data;
    const row = (z) => `<tr${z.broken ? ' class="above-row"' : ""}>
        <td><span class="lvl ${z.broken ? "above" : "support"}">${z.id}</span></td>
        <td class="num"><b>${money(z.price)}</b></td>
        <td class="num">${z.high - z.low < 0.005 ? '<span class="muted">single low</span>' : `${money(z.low)}–${money(z.high).slice(1)}`}</td>
        <td class="num">${z.inZone ? "in zone" : pct(z.distancePct)}</td>
        <td class="num">${z.touches}</td>
        <td>${fmtDate(z.date)}</td>
        <td class="strength"><span class="bar" aria-hidden="true"><i class="t${z.strength}" style="width:${z.score}%"></i></span><span class="tier">${z.strength}</span> <span class="muted">${z.score}</span></td>
        <td><span class="status ${z.status.replace(/ /g, "-")}">${z.status}</span>${
          z.broken ? (z.brokeDate ? `<span class="sub-cell">price closed below it ${fmtDate(z.brokeDate)}</span>` : "")
          : z.brokeBefore ? '<span class="sub-cell">broke once before</span>' : ""}</td>
      </tr>`;
    const sup = r.supports; // already nearest-first
    // levels above price go above the last-close row, highest first, so the table reads in price order
    let html = r.above.slice().reverse().map(row).join("");
    html += `<tr class="price-row"><td>Last close</td><td class="num">${money(r.price)}</td><td class="num muted">ATR ${money(r.atr)}</td><td colspan="5" class="muted">${d.dates[r.end]} · levels from the last ${r.end - r.levelStart + 1} sessions · zones are ${money(r.tol)} wide (${r.opts.clusterMult} × ATR)</td></tr>`;
    html += sup.length ? sup.map(row).join("")
      : r.above.length
        ? `<tr><td colspan="8" class="muted">No support below the price in the last ${r.end - r.levelStart + 1} sessions: the levels found are all above the price (${r.above.map((z) => z.id).join(", ")}), because the price has fallen through them.</td></tr>`
        : `<tr><td colspan="8" class="muted">No confirmed support zone in the last ${r.end - r.levelStart + 1} sessions — price has not put in enough swing lows. Try a longer window.</td></tr>`;
    if (r.fallbacks.length) {
      html += r.fallbacks.map((f) => `<tr><td><span class="lvl fallback">Fallback</span></td><td class="num">${money(f.price)}</td><td colspan="6" class="muted">${f.label} — shown because this window has fewer than two confirmed support zones.</td></tr>`).join("");
    }
    for (const side of ["above", "below"]) {
      const n = r.unlisted[side], shown = side === "above" ? r.above.length : sup.length;
      if (n > 0) html += `<tr class="foot-row"><td colspan="8" class="muted">${n} weaker level${n > 1 ? "s" : ""} ${side} the price ${n > 1 ? "are" : "is"} not listed; only the strongest ${shown} are shown.</td></tr>`;
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
        `Price sits at ${(l.bollinger.position * 100).toFixed(0)}% of its normal 20-day range (0% = lower band, 100% = upper band). Outside 0–100% means it closed through a band.`],
      ["ATR", "14-day", `${money(l.atr.value)} (${l.atr.pct.toFixed(1)}%)`, `Moves about ${l.atr.pct.toFixed(1)}% a day`,
        "The typical daily range. It sets how wide the support zones are and how far below a level a stop would sit."],
      ["Volume vs. average", "20-day average", `${compact(d.volume[i])} vs ${compact(d.vol_avg20[i])}`, l.volume.label,
        "Heavy volume at a support test suggests real buying behind the bounce."],
    ];
    $("#indTable tbody").innerHTML = rows.map((r) => `<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td class="num">${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td></tr>`).join("");
  }

  // "What changed": the last row of the bottom line, from the nightly comparison (state.changes)
  function renderChanges() {
    const ul = $("#changes"), ch = state.changes;
    if (!ul) return;
    if (!ch || !ch.items) { ul.innerHTML = `<li class="muted">No comparison available yet.</li>`; return; }
    const tags = { new: "New", broken: "Broken", reclaimed: "Reclaimed", dropped: "Dropped", trend: "Trend", rsi: "RSI", macd: "MACD", cross: "Cross" };
    ul.innerHTML = ch.items.length
      ? ch.items.map((x) => `<li><span class="tag ${esc(x.type)}">${esc(tags[x.type] || x.type)}</span><span>${esc(x.text)}</span></li>`).join("")
      : `<li class="muted">No changes to the support levels, trend or momentum labels.</li>`;
    $("#changesNote").textContent = ch.previous
      ? `${fmtDate(ch.as_of)} compared with ${fmtDate(ch.previous)}, for the levels shown when the page opens (the last ${SR.LEVEL_SESSIONS} sessions, 3-day swings). Levels within 1.5% of each other count as the same level.`
      : "";
  }

  /* ------------------------------------------------------------ rendering: charts */
  function legend(el, items) {
    el.innerHTML = items.map(([cls, style, label]) => `<li><span class="key ${cls}" style="${style}"></span>${label}</li>`).join("");
  }

  function mainTooltip(i) {
    const v = state.view, d = v.data;
    const chg = i > 0 ? (d.close[i] / d.close[i - 1] - 1) * 100 : 0;
    const sw = (x) => `<span class="sw" style="background:${css(x)}"></span>`;
    const tags = [];
    if (v.lows.includes(i)) tags.push(v.weekly ? "Swing low this week" : "Swing low");
    if (v.pendingLows.includes(i)) tags.push("Pending swing low");
    const lv = shownLevels();
    const zone = [...lv.below, ...lv.above]
      .find((z) => d.low[i] <= z.high + state.res.tol / 2 && d.high[i] >= z.low - state.res.tol / 2);
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    return `<div class="d">${fmtDate(d.dates[i])}${tags.length ? ` · ${tags.join(", ")}` : ""}</div><table>
      ${row("Open / Close", `${money(d.open[i])} / ${money(d.close[i])}`)}
      ${row("High / Low", `${money(d.high[i])} / ${money(d.low[i])}`)}
      ${row("Change", `<span class="${chg >= 0 ? "up" : "down"}">${pct(chg, 2)}</span>`)}
      ${zone ? row(zone.broken ? `${sw("--above")}In level above price` : `${sw("--support")}In support zone`, `${zone.id} ${money(zone.price)}`) : ""}
      ${row(`${sw("--rolling")}${state.opts.period}-day low`, money(v.rollingLow[i]))}
      ${row(`${sw("--sma20")}20 / ${sw("--sma50")}50 / ${sw("--sma200")}200-day`, `${money(d.sma20[i])} / ${money(d.sma50[i])} / ${money(d.sma200[i])}`)}
      ${state.panes.bb ? row(`${sw("--sma20")}Bollinger Bands`, `${money(d.bb_lower[i])} – ${money(d.bb_upper[i])}`) : ""}
      ${row("Volume", `${compact(d.volume[i])} (${(d.volume[i] / d.vol_avg20[i]).toFixed(1)}× avg)`)}
      ${row("RSI", d.rsi14[i]?.toFixed(1) ?? "–")}
      ${row("MACD / signal", d.macd[i] != null ? `${d.macd[i].toFixed(2)} / ${d.macd_signal[i].toFixed(2)}` : "–")}
      ${row("Below 12-month high", pct(d.drawdown[i], 1))}
    </table>`;
  }

  function buildMainChart() {
    const v = state.view, d = v.data;
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
          const lows = new Set(state.view.lows);
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
        range: (a, b) => withNextFloor(extent(state.panes.bb ? ["low", "high", "bb_upper", "bb_lower"] : ["low", "high"])(a, b)),
        draw: drawPricePane,
      },
      ...Object.keys(optional).filter((k) => state.panes[k]).map((k) => optional[k]),
    ];
    panes[panes.length - 1].gap = 0;
    const c = new StackChart($("#mainChart"), {
      // space right of the newest bar: half a bar, plus exactly the width of the widest price
      // tag, so the tags never cover a candle at 12 months nor leave a gap at 1 month
      panes, dates: v.dates, tooltip: mainTooltip, rightPad: 0.5, rightPadPx: tagRoom,
      dimBefore: () => state.view.levelStart, // history older than the level search
    });
    c.canvas.setAttribute("aria-label", `Candlestick chart of ${tk().symbol}, ${v.weekly ? "one bar per Monday" : "one bar per trading day"}, with shaded support zones and optional volume, RSI, MACD and drawdown panels. The levels table below lists the same zones.`);
    return c;
  }

  function rebuildMainChart({ resetView = false } = {}) {
    const old = state.charts.main;
    const view = !resetView && old && old.view;
    old && old.destroy();
    state.view = SR.chartModel(state.data, state.res, state.cadence);
    state.charts.main = buildMainChart();
    renderLegends();
    state.charts.main.home = homeView();
    if (view) state.charts.main.setView(view.from, view.to, [0, state.view.dates.length - 1]);
    else renderCharts();
  }

  // The price scale reaches down to the next floor below the current one (S2 when the price
  // is at or above S1), so "if that breaks" is visible on the chart. It stretches by at most
  // half, so a far-off floor cannot squash the candles; then the edge tag names it instead.
  const NEXT_FLOOR_STRETCH = 0.5;
  function withNextFloor([lo, hi]) {
    const next = shownLevels().below[1]; // the next floor, when more than S1 is shown
    if (!next) return [lo, hi];
    const want = next.low - state.res.tol / 2;
    if (want >= lo || hi - want > (hi - lo) * (1 + NEXT_FLOOR_STRETCH)) return [lo, hi];
    return [want, hi];
  }

  // The nearest level below or at the price (S1, the zone the price is in when it is in one)
  // and the nearest above (A1) are always on the chart; the two switches add the rest.
  function shownLevels() {
    const r = state.res;
    return {
      below: state.panes.zones ? r.supports : r.supports.slice(0, 1),
      above: state.panes.above ? r.above : r.above.slice(0, 1),
    };
  }

  const TAG_FONT = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif'; // as draw.tag
  let measureCtx = null;
  function tagRoom() {
    const r = state.res;
    if (!r) return 0;
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = TAG_FONT;
    const texts = [money(r.price), ...r.supports.map((z) => `${z.id} ${money(z.price)}`), ...r.above.map((z) => `${z.id} ${money(z.price)}`)];
    return Math.max(...texts.map((t) => measureCtx.measureText(t).width)) + 8 /* tag padding */ + 6 /* gap */;
  }

  function drawPricePane(ctx, S) {
    const v = state.view, d = v.data, r = state.res;
    const sup = css("--support");
    const half = r.tol / 2;
    // 1. optional volume-by-price profile, drawn behind everything on the right
    if (state.panes.profile) {
      const prof = SR.volumeProfile(state.data, r, 32); // a price histogram: always from daily bars
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
    let labels = [];
    const alphaFor = { Strong: 0.22, Moderate: 0.13, Weak: 0.07 };
    const lv = shownLevels();
    state.shownLevels = lv; // read by the browser tests
    for (const z of lv.below) {
      const y1 = S.y(z.high + half), y2 = S.y(z.low - half);
      const h = Math.max(4, y2 - y1);
      ctx.fillStyle = withAlpha(sup, alphaFor[z.strength]);
      ctx.fillRect(S.left, y1, S.right - S.left, h);
      // centre line at the zone price
      ctx.strokeStyle = withAlpha(sup, 0.85);
      ctx.lineWidth = z.strength === "Strong" ? 2 : 1.25;
      const ym = Math.round(S.y(z.price)) + 0.5;
      ctx.beginPath(); ctx.moveTo(S.left, ym); ctx.lineTo(S.right, ym); ctx.stroke();
      labels.push({ y: S.y(z.price), text: `${z.id} ${money(z.price)}`, col: sup, z });
    }
    // levels above price: a muted band with a dashed centre line, so they never read as support
    {
      const ab = css("--above");
      for (const z of lv.above) {
        const y1 = S.y(z.high + half), y2 = S.y(z.low - half);
        ctx.fillStyle = withAlpha(ab, 0.10);
        ctx.fillRect(S.left, y1, S.right - S.left, Math.max(4, y2 - y1));
        draw.hline(ctx, S, z.price, withAlpha(ab, 0.9), [5, 4], 1.25);
        labels.push({ y: S.y(z.price), text: `${z.id} ${money(z.price)}`, col: ab, z });
      }
    }
    // fallback levels for thin windows
    r.fallbacks.forEach((f) => {
      draw.hline(ctx, S, f.price, sup, [2, 3], 1.25);
      labels.push({ y: S.y(f.price), text: money(f.price), col: sup });
    });
    // Bollinger Bands: two standard deviations either side of the 20-day average. The
    // middle band is the 20-day average itself, which is drawn below, so it is not repeated.
    if (state.panes.bb) {
      const bb = css("--sma20");
      draw.band(ctx, S, d.bb_upper, d.bb_lower, withAlpha(bb, 0.07));
      draw.line(ctx, S, d.bb_upper, withAlpha(bb, 0.6), 1, [4, 3]);
      draw.line(ctx, S, d.bb_lower, withAlpha(bb, 0.6), 1, [4, 3]);
    }
    // 3. moving averages & rolling low (the 20-day is thinner: it is context, not a level)
    if (state.panes.sma200) draw.line(ctx, S, d.sma200, css("--sma200"), 2);
    if (state.panes.sma50) draw.line(ctx, S, d.sma50, css("--sma50"), 2);
    if (state.panes.sma20) draw.line(ctx, S, d.sma20, css("--sma20"), 1.25);
    if (state.panes.rolling) {
      draw.step(ctx, S, v.rollingLow.map((x, i) => (i >= v.start ? x : null)), withAlpha(css("--rolling"), 0.75), 1.25);
    }
    // 4. candles
    draw.candles(ctx, S, d, css("--candle"), css("--candle"));
    // 5. swing-low markers
    const off = Math.max(8, S.barW * 0.3 + 6);
    const size = S.mobile ? 4 : 4.5;
    const used = new Set(v.used); // bars carrying a low that built one of S1…S5
    if (state.panes.swings) v.lows.forEach((i) => draw.triangle(ctx, S.x(i), S.y(d.low[i]) + off, "up",
      used.has(i) ? sup : withAlpha(sup, 0.34), false, used.has(i) ? size : size - 1));
    if (state.panes.swings) v.pendingLows.forEach((i) => draw.triangle(ctx, S.x(i), S.y(d.low[i]) + off, "up", sup, true, size));
    // 6. window start marker
    if (v.start > S.i0) {
      const x = Math.round(S.x(v.start) - S.barW / 2) + 0.5;
      ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, S.top); ctx.lineTo(x, S.bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = css("--text-muted"); ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("window starts", x + 4, S.top + 3);
    }
    // 7. labels on the right edge, de-overlapped, plus the last price tag. A level outside
    // the visible price range gets no tag of its own (pushed into view, it would sit next to
    // the wrong price); a single tag at that edge says how many are out of view instead.
    // Tags sit 17px apart. The last-price tag stays exactly on its price; the others are placed
    // outward from it, nearest first. Levels out of view, and tags that would run off the panel,
    // are folded into one tag at that edge, which names the nearest of them.
    const anchor = { y: S.y(r.price), text: money(r.price), col: css("--text-primary"), last: true };
    const outAbove = labels.filter((l) => l.z && l.y < S.top + 4), outBelow = labels.filter((l) => l.z && l.y > S.bottom - 4);
    labels = labels.filter((l) => l.y >= S.top + 4 && l.y <= S.bottom - 4);
    for (const l of labels) l.target = l.z ? l.y : null;
    const place = (list, dir, reserve) => {
      const limit = dir < 0 ? S.top + 9 + reserve : S.bottom - 9 - reserve;
      const kept = [], dropped = [];
      let prev = anchor.y;
      for (const l of list) {
        const y = dir < 0 ? Math.min(l.target ?? l.y, prev - 17) : Math.max(l.target ?? l.y, prev + 17);
        if (dir < 0 ? y < limit : y > limit) { if (l.z) dropped.push(l); continue; }
        l.y = prev = y;
        kept.push(l);
      }
      return { kept, dropped };
    };
    const side = (list, dir, outside) => {
      let res = place(list, dir, outside.length ? 17 : 0);
      if (!outside.length && res.dropped.length) res = place(list, dir, 17); // make room for the edge tag
      return { kept: res.kept, folded: [...outside, ...res.dropped] };
    };
    const up = side(labels.filter((l) => l.y <= anchor.y).sort((a, b) => b.y - a.y), -1, outAbove);
    const down = side(labels.filter((l) => l.y > anchor.y).sort((a, b) => a.y - b.y), 1, outBelow);
    const nearest = (list, dir) => list.slice().sort((a, b) => dir * (b.z.price - a.z.price))[0];
    const edgeText = (list, dir, arrow, word) => {
      const z = nearest(list, dir).z;
      return `${arrow} ${z.id} ${money(z.price)}` + (list.length > 1 ? ` · ${list.length - 1} more ${word}` : ` ${word}`);
    };
    labels = [...up.kept.reverse(), anchor, ...down.kept];
    const muted = css("--text-muted");
    // an edge tag goes in its right-hand corner, or the left-hand one if the price tag is in the way
    const corner = (y) => (Math.abs(y - anchor.y) < 17 ? "left" : "right");
    if (up.folded.length) labels.unshift({ y: S.top + 9, text: edgeText(up.folded, -1, "▲", "above"), col: muted, edge: true, align: corner(S.top + 9) });
    if (down.folded.length) labels.push({ y: S.bottom - 9, text: edgeText(down.folded, 1, "▼", "below"), col: muted, edge: true, align: corner(S.bottom - 9) });
    state.offChart = { // levels without a tag of their own; read by the browser tests
      above: up.folded.length, below: down.folded.length,
      nearestAbove: up.folded.length ? nearest(up.folded, -1).z.id : null, nearestBelow: down.folded.length ? nearest(down.folded, 1).z.id : null,
    };
    // where each tag ended up, for the browser tests that check nothing collides
    state.tagBoxes = labels.map((l) => {
      const left = l.align === "left";
      const w = draw.tag(ctx, left ? S.left + 4 : S.right - 2, l.y, l.text, l.col, l.last ? css("--surface-1") : "#fff", left ? "left" : "right");
      const target = l.last ? S.y(r.price) : l.target;
      // a tag moved off its line gets a short connecting line back to the level it names
      const leader = target != null && Math.abs(l.y - target) > 2;
      if (leader) {
        ctx.strokeStyle = l.col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(S.right - 2 - w, l.y); ctx.lineTo(S.right - 2 - w - 8, target); ctx.stroke();
      }
      const x0 = left ? S.left + 4 : S.right - 2 - w;
      return { text: l.text, left: x0, right: x0 + w, top: l.y - 8, bottom: l.y + 8, y: l.y, target, leader, edge: !!l.edge };
    });
  }

  function buildBenchChart() {
    const d = state.data;
    const idx = { t: [], q: [] };
    const recompute = () => {
      const s = state.res.start;
      idx.t = d.close.map((v, i) => (i >= s ? (v / d.close[s]) * 100 : null));
      idx.q = d.bench_close.map((v, i) => (i >= s ? (v / d.bench_close[s]) * 100 : null));
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
        <tr><td><span class="sw" style="background:${css("--accent")}"></span>${esc(tk().symbol)}</td><td>${idx.t[i] != null ? "$" + idx.t[i].toFixed(1) : "–"}</td></tr>
        <tr><td><span class="sw" style="background:${css("--qqq")}"></span>${esc(tk().benchmark)}</td><td>${idx.q[i] != null ? "$" + idx.q[i].toFixed(1) : "–"}</td></tr></table>`,
    });
    c.canvas.setAttribute("aria-label", `Line chart comparing growth of $100 in ${tk().symbol} and ${tk().benchmark} over the selected window.`);
    c.recompute = recompute;
    return c;
  }

  function renderBenchStats() {
    const b = SR.benchmark(state.data, state.res);
    $("#benchStats").innerHTML = `
      <div><b>${pct(b.symReturn)}</b><span>${esc(tk().symbol)} return</span></div>
      <div><b>${pct(b.benchReturn)}</b><span>${esc(tk().benchmark)} return${b.leverage > 1 ? ` (${b.leverage}× = ${pct(b.naiveLev, 0)})` : ""}</span></div>
      <div><b>${b.beta.toFixed(2)}×</b><span>Daily beta to ${esc(tk().benchmark)}</span></div>
      <div><b>${b.volSym.toFixed(0)}% / ${b.volBench.toFixed(0)}%</b><span>Annualised volatility</span></div>`;
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

  /** The view the chart opens on, and returns to on reset: the window plus a little context. */
  function homeView() {
    const v = state.view, end = v.dates.length - 1;
    const lead = Math.round((end - v.start) * 0.06);
    return [Math.max(0, v.start - lead), end];
  }

  function renderCharts({ keepView } = {}) {
    const r = state.res;
    const main = state.charts.main;
    // users can still pan or zoom out to the full 2 years
    const [from, end] = homeView();
    main.home = [from, end];
    if (keepView && main.view) main.render(); else main.setView(from, end, [0, end]);
    const b = state.charts.bench;
    b.recompute();
    b.setView(r.start, state.data.dates.length - 1, [r.start, state.data.dates.length - 1]);
    state.charts.cmp && state.charts.cmp.render();
  }

  function renderLegends() {
    legend($("#legend"), [
      ...(state.res.supports.length ? [["box strong", `background:${withAlpha(css("--support"), 0.30)};border:1px solid ${css("--support")}`, "Support zone (darker = stronger)"]] : []),
      ...(state.res.above.length ? [["box", `background:${withAlpha(css("--above"), 0.18)};border:1px dashed ${css("--above")}`, "Level above price (was support)"]] : []),
      ...(state.panes.swings ? [
        ["tri", `border-bottom-color:${css("--support")}`, "Swing low that built a level"],
        ["tri faint", `border-bottom-color:${css("--support")}`, "Other swing low"],
        ["tri hollow", `border-bottom-color:${css("--support")}`, "Pending (not yet confirmed)"]] : []),
      ["candle", "", "Up day"], ["candle fill", "", "Down day"],
      ...(state.panes.rolling ? [["", `border-color:${css("--rolling")}`, `${state.opts.period}-day rolling low`]] : []),
      ...(state.panes.sma20 ? [["", `border-color:${css("--sma20")}`, "20-day avg"]] : []),
      ...(state.panes.sma50 ? [["", `border-color:${css("--sma50")}`, "50-day avg"]] : []),
      ...(state.panes.sma200 ? [["", `border-color:${css("--sma200")}`, "200-day avg"]] : []),
      ...(state.panes.bb ? [["box", `background:${withAlpha(css("--sma20"), 0.10)};border:1px dashed ${css("--sma20")}`, "Bollinger Bands (normal range around the 20-day avg)"]] : []),
    ]);
    legend($("#cmpLegend"), [
      ["dot", `background:${css("--support")}`, "Support level (size = strength)"],
      ["dot ring", `border-color:${css("--support")}`, "Found in 3+ windows"],
      ["dash", `border-color:${css("--text-secondary")}`, "Last close"],
    ]);
    legend($("#benchLegend"), [["", `border-color:${css("--accent")}`, esc(tk().symbol)], ["", `border-color:${css("--qqq")}`, esc(tk().benchmark)]]);
  }

  /* ------------------------------------------------------------ downloads */
  function downloadCsv() {
    const r = state.res, d = state.data;
    const lines = [
      `# ${tk().symbol} support levels, data as of ${d.meta.as_of}, window ${r.opts.window} sessions, levels from the last ${r.end - r.levelStart + 1} sessions, swing period ${r.opts.period}, cluster ${r.opts.clusterMult}xATR, min touches ${r.opts.minTouches}`,
      "level,zone_price,zone_low,zone_high,distance_pct,touches,last_test,first_seen,strength_score,strength,status,volume_vs_avg",
      ...[...r.above.slice().reverse(), ...r.supports].map((z) => [z.id, z.price.toFixed(2), z.low.toFixed(2), z.high.toFixed(2),
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
    a.download = `${tk().symbol.toLowerCase()}-support-${d.meta.as_of}-${r.opts.window}d.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ------------------------------------------------------------ main loop */
  function update({ keepView = false } = {}) {
    state.res = analyze();
    state.lab = SR.labels(state.data, state.res);
    state.runs = SR.compareWindows(state.data, state.opts); // shared by the findings and the window chart
    state.view = SR.chartModel(state.data, state.res, state.cadence);
    syncControls();
    writeUrl();
    renderBottomLine();
    renderFindings();
    renderKpis();
    renderTable();
    renderIndicators();
    renderLegends();
    renderBenchStats();
    renderCompare();
    renderCharts({ keepView });
    document.title = `${tk().symbol} Support Levels · ${money(state.res.price)} · ${state.data.meta.as_of}`;
  }

  /** The current ticker's name, benchmark and leverage (from its data file, else the list). */
  const tk = () => SR.tickerInfo(state.data || { meta: state.ticker });

  /** Put the ticker's name, benchmark and leverage into the page's fixed text. */
  function renderTickerText() {
    const t = tk();
    $$("[data-tk]").forEach((el) => (el.textContent = t[el.dataset.tk]));
    const lev = t.leverage > 1;
    $("#tickerDesc").textContent = lev ? `${t.name} (${t.leverage}× ${t.index})` : t.index ? `${t.name} · tracks the ${t.index}` : t.name;
    $("#benchHelp").innerHTML = lev
      ? `What $100 would have grown to over the selected window. ${esc(t.symbol)} aims for ${t.leverage}× ${esc(t.benchmark)}'s <em>daily</em> move; over longer periods the result drifts away from ${t.leverage}× the period return, more so in choppy markets.`
      : `What $100 would have grown to over the selected window in ${esc(t.symbol)}, and in ${esc(t.benchmark)} for comparison.`;
    $("#riskNote").textContent = lev
      ? `${t.symbol} is a ${t.leverage}× leveraged ETF that resets daily; it can lose value quickly, and over periods longer than a day its return can differ greatly from ${t.leverage}× the ${t.index}.`
      : t.index ? `${t.symbol} is an exchange-traded fund that tracks the ${t.index}; it can still fall sharply.`
        : `${t.symbol} can fall sharply, like any single security.`;
  }

  /** Open the page for another ticker, keeping the other settings. */
  function goToTicker(symbol) {
    if (state.leaving) return; // already opening one (Enter can arrive twice, see renderTickerField)
    state.leaving = true;
    state.ticker = state.listing.tickers.find((t) => t.symbol === symbol) || { symbol };
    writeUrl({ now: true });
    location.reload();
  }

  /**
   * The one ticker field: its suggestions are the tickers on the daily list (with their
   * names); typing any other symbol opens it live. On focus it empties, showing the current
   * ticker as a hint, so the whole list of suggestions appears; leaving it puts the ticker back.
   */
  function renderTickerField() {
    const input = $("#tickerInput"), current = state.ticker.symbol;
    $("#tickerList").innerHTML = state.listing.tickers.map((t) => `<option value="${esc(t.symbol)}">${esc(t.name)}</option>`).join("");
    input.value = current;
    input.onfocus = () => { input.placeholder = current; input.value = ""; };
    input.onblur = () => { if (!input.value.trim()) input.value = current; };
    // picking a suggestion opens it straight away; typed letters wait for Enter or Show,
    // so typing "QQQM" does not stop at "QQQ" (browsers mark a picked suggestion this way)
    input.oninput = (e) => {
      const v = input.value.trim().toUpperCase();
      if (e.inputType === "insertReplacementText" && v !== current && state.listing.tickers.some((t) => t.symbol === v)) goToTicker(v);
    };
    // Safari does not send Enter to the form when the field has a suggestion list, so Enter
    // sends it here if the browser has not done so by the next tick
    let submitted = false;
    input.onkeydown = (e) => {
      if (e.key === "Enter") setTimeout(() => { if (!submitted) $("#tickerForm").requestSubmit(); }, 0);
    };
    $("#tickerForm").onsubmit = (e) => {
      e.preventDefault();
      submitted = true;
      setTimeout(() => { submitted = false; }, 0);
      const sym = (input.value.trim() || current).toUpperCase();
      if (sym === current) return;
      if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(sym)) goToTicker(sym);
      else showNote(`"${sym}" is not a ticker symbol: use 1 to 10 letters, digits, dots or dashes, starting with a letter.`);
    };
  }

  function showNote(text, addSymbol) {
    $("#tickerNoteText").textContent = text;
    const add = $("#addTicker");
    add.hidden = !addSymbol;
    if (addSymbol) {
      add.textContent = `Add ${addSymbol} to the daily list`;
      add.disabled = false;
      add.onclick = () => requestAdd(addSymbol);
    }
    $("#tickerNote").hidden = false;
  }

  /** Ask the Worker to add a ticker to the daily list, and say what it answered. */
  async function requestAdd(symbol) {
    const add = $("#addTicker");
    add.disabled = true;
    add.textContent = "Asking…";
    let answer;
    try {
      const r = await fetch(`${state.listing.proxy}/add?symbol=${encodeURIComponent(symbol)}`, { method: "POST" });
      answer = await r.json();
    } catch (e) {
      answer = { status: "error", message: "Could not reach the lookup service. Please try again later." };
    }
    $("#tickerNoteText").textContent = answer.message;
    add.hidden = true;
  }

  /**
   * A ticker not on the list: fetch its prices from the lookup service (proxy/worker.mjs) and
   * work out its indicators here. Returns the payload, or null with a note saying why not.
   */
  async function liveTicker(want) {
    const fallback = state.listing.default;
    if (!state.listing.proxy) {
      showNote(`${want} is not on the list of tickers this report covers yet, and looking up other tickers is not switched on, so ${fallback} is shown.`);
      return null;
    }
    let r, body;
    try {
      r = await fetch(`${state.listing.proxy}/prices?symbol=${encodeURIComponent(want)}`);
      body = await r.json();
    } catch (e) {
      showNote(`Could not reach the lookup service for ${want}, so ${fallback} is shown. Please try again later.`);
      return null;
    }
    if (!r.ok) {
      showNote(`${body.message} ${fallback} is shown instead.`);
      return null;
    }
    Object.assign(body.series, SI.computeAll(body.series)); // the indicators the nightly job would have stored
    return body;
  }

  async function init() {
    readUrl();
    bindControls();
    try {
      const bust = "?v=" + Math.floor(Date.now() / 3.6e6); // refresh at least hourly past the CDN cache
      const base = SR.dataBase(location); // the market-data branch on GitHub Pages, else data/ here
      state.listing = (await fetch(base + "data/tickers.json" + bust).then((r) => (r.ok ? r.json() : null)).catch(() => null)) || FALLBACK_LIST;
      const want = state.requestedTicker || state.listing.default;
      state.ticker = state.listing.tickers.find((t) => t.symbol === want);
      let payload = null, changes = null;
      if (!state.ticker) {
        payload = await liveTicker(want);
        if (payload) {
          state.ticker = { ...payload.meta, live: true };
          showNote(`${want} is not on the daily list yet. It is shown live from today's prices; its history and "What changed" start once it is added.`, want);
        } else {
          state.ticker = state.listing.tickers.find((t) => t.symbol === state.listing.default);
        }
      }
      renderTickerField();
      if (!payload) {
        const dir = base + state.ticker.dir, file = `${dir}/${state.ticker.symbol.toLowerCase()}.json`;
        [payload, changes] = await Promise.all([
          fetch(file + bust).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
          fetch(`${dir}/changes.json` + bust).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
      }
      // the list fills in any field an older data file does not carry
      payload.meta = { ...state.ticker, ...payload.meta };
      state.data = SR.fromPayload(payload);
      renderTickerText();
      renderHeader();
      state.changes = changes;
      state.res = analyze();
      state.view = SR.chartModel(state.data, state.res, state.cadence);
      state.charts.main = buildMainChart();
      state.charts.bench = buildBenchChart();
      update();
      pollQuote();
    } catch (e) {
      console.error(e);
      $("#blHeadline").textContent = `Could not load the data file (${esc(e.message)}). Please try again later.`;
      $("#asOf").textContent = "Data unavailable";
    }
  }

  init();
})();
