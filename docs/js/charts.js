/*
 * Minimal, dependency-free canvas charts for the TQQQ dashboard.
 *   StackChart     – vertically stacked panes sharing one date axis (pan / zoom / crosshair)
 *   LevelDotChart  – support & resistance levels found with several windows (window comparison)
 * Colours come from CSS custom properties so light/dark themes just work.
 */
(function (root) {
  "use strict";

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

  function niceTicks(min, max, count = 5) {
    if (!(max > min)) return [min];
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function withAlpha(color, a) {
    if (color.startsWith("#")) {
      let h = color.slice(1);
      if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      const n = parseInt(h, 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    return color;
  }

  function setupCanvas(canvas, width, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  /* ================================================================ StackChart */
  class StackChart {
    /**
     * opts: {
     *   panes: [{ id, height, mobileHeight, range(from,to) -> [min,max], draw(ctx, S), format(v), title, gap }],
     *   dates: [...], tooltip(i) -> html, onHover(i), minBars
     * }
     */
    constructor(host, opts) {
      this.host = host;
      this.o = Object.assign({ minBars: 10, rightPad: 3 }, opts);
      this.canvas = document.createElement("canvas");
      this.canvas.className = "chart-canvas";
      this.canvas.setAttribute("role", "img");
      this.tip = document.createElement("div");
      this.tip.className = "chart-tip";
      this.tip.hidden = true;
      host.classList.add("chart-host");
      host.append(this.canvas, this.tip);
      this.hover = null;
      this.pointers = new Map();
      this.bindEvents();
      this.ro = new ResizeObserver(() => this.render());
      this.ro.observe(host);
    }

    setView(from, to, bounds) {
      this.bounds = bounds || this.bounds || [0, this.o.dates.length - 1];
      this.view = { from, to };
      this.clampView();
      this.render();
    }

    resetView() {
      this.setView(this.bounds[0], this.bounds[1]);
    }

    clampView() {
      const [b0, b1] = this.bounds;
      let { from, to } = this.view;
      let span = clamp(to - from, this.o.minBars, b1 - b0);
      from = clamp(from, b0, b1 - span);
      this.view = { from, to: from + span };
    }

    zoom(factor, anchor) {
      const { from, to } = this.view;
      const a = anchor ?? (from + to) / 2;
      this.view = { from: a - (a - from) * factor, to: a + (to - a) * factor };
      this.clampView();
      this.render();
    }

    layout() {
      const w = this.host.clientWidth;
      const mobile = w < 640;
      const axisW = mobile ? 46 : 58;
      const top = 8, xAxisH = 22;
      let y = top;
      const panes = this.o.panes.map((p) => {
        const h = mobile ? (p.mobileHeight ?? p.height * 0.7) : p.height;
        const pane = { ...p, y, h };
        y += h + (p.gap ?? 14);
        return pane;
      });
      const height = y - 14 + xAxisH;
      return { w, height, left: 6, right: w - axisW, axisW, panes, mobile, xAxisY: y - 14 };
    }

    render() {
      if (!this.view || !this.host.clientWidth) return;
      const L = (this.L = this.layout());
      const ctx = (this.ctx = setupCanvas(this.canvas, L.w, L.height));
      const { from, to } = this.view;
      const pad = this.o.rightPad;
      const plotW = L.right - L.left;
      const xScale = (i) => L.left + ((i - from + 0.5) / (to - from + 1 + pad)) * plotW;
      const barW = plotW / (to - from + 1 + pad);
      const i0 = Math.max(0, Math.floor(from)), i1 = Math.min(this.o.dates.length - 1, Math.ceil(to));
      this.xScale = xScale;
      this.barW = barW;
      const ink = { grid: css("--grid"), axis: css("--axis"), muted: css("--text-muted"), text: css("--text-secondary"), surface: css("--surface-1") };
      ctx.fillStyle = ink.surface;
      ctx.fillRect(0, 0, L.w, L.height);
      ctx.font = FONT;

      for (const p of L.panes) {
        const [mn, mx] = p.range(i0, i1);
        const padY = (mx - mn) * (p.padY ?? 0.06) || 1;
        const lo = p.fixed ? mn : mn - padY, hi = p.fixed ? mx : mx + padY;
        const y = (v) => p.y + p.h - ((v - lo) / (hi - lo)) * p.h;
        const S = { x: xScale, y, i0, i1, barW, lo, hi, pane: p, left: L.left, right: L.right, top: p.y, bottom: p.y + p.h, ctx, mobile: L.mobile };
        p.S = S;
        // grid + axis labels
        const ticks = p.ticks ? p.ticks(lo, hi) : niceTicks(lo, hi, Math.max(2, Math.round(p.h / 60)));
        ctx.strokeStyle = ink.grid; ctx.lineWidth = 1;
        ctx.fillStyle = ink.muted; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        for (const t of ticks) {
          const ty = Math.round(y(t)) + 0.5;
          if (ty < p.y - 1 || ty > p.y + p.h + 1) continue;
          ctx.beginPath(); ctx.moveTo(L.left, ty); ctx.lineTo(L.right, ty); ctx.stroke();
          ctx.fillText((p.format || String)(t), L.right + 6, ty);
        }
        ctx.save();
        ctx.beginPath(); ctx.rect(L.left, p.y, L.right - L.left, p.h); ctx.clip();
        p.draw(ctx, S);
        ctx.restore();
        if (p.title) { // drawn over the data on a soft backdrop so lines never hide it
          ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
          const tw = ctx.measureText(p.title).width;
          ctx.fillStyle = withAlpha(ink.surface, 0.85);
          ctx.fillRect(L.left, p.y, tw + 10, 17);
          ctx.fillStyle = ink.text; ctx.textAlign = "left"; ctx.textBaseline = "top";
          ctx.fillText(p.title, L.left + 4, p.y + 3);
          ctx.font = FONT;
        }
        // baseline
        ctx.strokeStyle = ink.axis;
        ctx.beginPath(); ctx.moveTo(L.left, p.y + p.h + 0.5); ctx.lineTo(L.right, p.y + p.h + 0.5); ctx.stroke();
      }

      // x axis: month ticks
      ctx.fillStyle = ink.muted; ctx.textAlign = "center"; ctx.textBaseline = "top";
      const dates = this.o.dates;
      const span = i1 - i0;
      const monthStep = span > 400 ? 3 : span > 200 ? 2 : 1;
      let lastX = -1e9;
      for (let i = Math.max(i0, 1); i <= i1; i++) {
        const m = +dates[i].slice(5, 7), pm = +dates[i - 1].slice(5, 7);
        let label = null;
        if (span <= 45) {
          if (i % Math.ceil(span / 6) === 0) label = dates[i].slice(5);
        } else if (m !== pm && (m - 1) % monthStep === 0) {
          label = m === 1 ? dates[i].slice(0, 4) : new Date(dates[i] + "T12:00:00Z").toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        }
        if (!label) continue;
        const x = xScale(i);
        if (x - lastX < 44) continue;
        lastX = x;
        ctx.fillText(label, x, L.xAxisY + 5);
        ctx.strokeStyle = ink.grid;
        for (const p of L.panes) { ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, p.y); ctx.lineTo(Math.round(x) + 0.5, p.y + p.h); ctx.stroke(); }
      }

      this.drawHover();
    }

    drawHover() {
      const i = this.hover;
      if (i == null || !this.L) { this.tip.hidden = true; return; }
      const ctx = this.ctx, L = this.L;
      const x = Math.round(this.xScale(i)) + 0.5;
      ctx.save();
      ctx.strokeStyle = css("--text-muted");
      ctx.setLineDash([3, 3]);
      for (const p of L.panes) { ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke(); }
      ctx.setLineDash([]);
      // date label on the axis
      const d = this.o.dates[i];
      ctx.font = FONT;
      const tw = ctx.measureText(d).width + 10;
      ctx.fillStyle = css("--text-primary");
      ctx.fillRect(x - tw / 2, L.xAxisY + 2, tw, 16);
      ctx.fillStyle = css("--surface-1"); ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(d, x, L.xAxisY + 5);
      if (this.hoverY != null) {
        const p = L.panes.find((q) => this.hoverY >= q.y && this.hoverY <= q.y + q.h);
        if (p) {
          const v = p.S.lo + (1 - (this.hoverY - p.y) / p.h) * (p.S.hi - p.S.lo);
          const label = (p.format || String)(v);
          const lw = Math.max(L.axisW - 4, ctx.measureText(label).width + 8);
          ctx.strokeStyle = css("--text-muted"); ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(L.left, this.hoverY + 0.5); ctx.lineTo(L.right, this.hoverY + 0.5); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = css("--text-primary");
          ctx.fillRect(L.right + 2, this.hoverY - 8, lw, 16);
          ctx.fillStyle = css("--surface-1"); ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(label, L.right + 5, this.hoverY);
        }
      }
      ctx.restore();
      if (this.o.tooltip) {
        this.tip.innerHTML = this.o.tooltip(i);
        this.tip.hidden = false;
        const tw2 = this.tip.offsetWidth, hostW = this.host.clientWidth;
        let left = x + 14;
        if (left + tw2 > L.right) left = x - 14 - tw2;
        this.tip.style.left = clamp(left, 0, hostW - tw2) + "px";
        this.tip.style.top = (L.panes[0].y + 6) + "px";
      }
    }

    indexAt(px) {
      const { from, to } = this.view;
      const L = this.L;
      const f = (px - L.left) / (L.right - L.left);
      const i = Math.round(from + f * (to - from + 1 + this.o.rightPad) - 0.5);
      return clamp(i, Math.max(0, Math.floor(from)), Math.min(this.o.dates.length - 1, Math.ceil(to)));
    }

    setHover(i, y) {
      if (i === this.hover && y === this.hoverY) return;
      this.hover = i; this.hoverY = y;
      this.render();
      this.o.onHover && this.o.onHover(i);
    }

    bindEvents() {
      const c = this.canvas;
      const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      let drag = null, pinch = null;
      c.addEventListener("pointerdown", (e) => {
        this.pointers.set(e.pointerId, pos(e));
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          pinch = { d: Math.abs(a.x - b.x) || 1, view: { ...this.view }, mid: this.indexAt((a.x + b.x) / 2) };
          drag = null;
        } else {
          drag = { x: pos(e).x, y: pos(e).y, view: { ...this.view }, moved: false, pointerType: e.pointerType };
        }
      });
      c.addEventListener("pointermove", (e) => {
        const p = pos(e);
        if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
        if (pinch && this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          const d = Math.abs(a.x - b.x) || 1;
          const f = pinch.d / d;
          const { from, to } = pinch.view;
          this.view = { from: pinch.mid - (pinch.mid - from) * f, to: pinch.mid + (to - pinch.mid) * f };
          this.clampView(); this.render();
          return;
        }
        if (drag) {
          const dx = p.x - drag.x, dy = p.y - drag.y;
          if (!drag.moved && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) { drag.moved = true; c.setPointerCapture(e.pointerId); }
          if (drag.moved) {
            const perBar = (this.L.right - this.L.left) / (drag.view.to - drag.view.from + 1 + this.o.rightPad);
            const shift = -dx / perBar;
            this.view = { from: drag.view.from + shift, to: drag.view.to + shift };
            this.clampView();
            this.hover = null;
            this.render();
            return;
          }
        }
        if (p.x <= this.L.right) this.setHover(this.indexAt(p.x), p.y);
      });
      const end = (e) => {
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) pinch = null;
        if (drag && !drag.moved && e.type === "pointerup" && e.pointerType !== "mouse") {
          const p = pos(e);
          this.setHover(this.indexAt(p.x), p.y);
        }
        drag = null;
      };
      c.addEventListener("pointerup", end);
      c.addEventListener("pointercancel", end);
      c.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { this.setHover(null, null); } });
      c.addEventListener("wheel", (e) => {
        if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return; // plain wheel scrolls the page
        e.preventDefault();
        const i = this.indexAt(pos(e).x);
        this.zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, i);
      }, { passive: false });
      c.addEventListener("dblclick", () => this.resetView());
      c.tabIndex = 0;
      c.addEventListener("keydown", (e) => {
        const n = this.o.dates.length - 1;
        if (e.key === "+" || e.key === "=") this.zoom(1 / 1.25);
        else if (e.key === "-") this.zoom(1.25);
        else if (e.key === "0") this.resetView();
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const cur = this.hover ?? Math.round(this.view.to);
          this.setHover(clamp(cur + (e.key === "ArrowLeft" ? -1 : 1), Math.ceil(this.view.from), Math.min(n, Math.floor(this.view.to))), null);
        } else if (e.key === "Escape") this.setHover(null, null);
        else return;
        e.preventDefault();
      });
    }

    toPNG(title) {
      const src = this.canvas;
      const dpr = src.width / src.clientWidth;
      const head = 34 * dpr;
      const out = document.createElement("canvas");
      out.width = src.width; out.height = src.height + head;
      const g = out.getContext("2d");
      g.fillStyle = css("--surface-1"); g.fillRect(0, 0, out.width, out.height);
      g.fillStyle = css("--text-primary");
      g.font = `600 ${14 * dpr}px system-ui, sans-serif`;
      g.textBaseline = "middle";
      g.fillText(title, 10 * dpr, head / 2);
      g.drawImage(src, 0, head);
      return out.toDataURL("image/png");
    }
  }

  /* ---------------------------------------------------------------- drawing helpers */
  const draw = {
    line(ctx, S, values, color, width = 2, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      let on = false;
      for (let i = S.i0; i <= S.i1; i++) {
        const v = values[i];
        if (v == null) { on = false; continue; }
        const x = S.x(i), y = S.y(v);
        on ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        on = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    },
    step(ctx, S, values, color, width = 1.5) {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "miter";
      ctx.beginPath();
      let on = false;
      for (let i = S.i0; i <= S.i1; i++) {
        const v = values[i];
        if (v == null) { on = false; continue; }
        const xl = S.x(i) - S.barW / 2, xr = S.x(i) + S.barW / 2, y = S.y(v);
        if (on) ctx.lineTo(xl, y); else ctx.moveTo(xl, y);
        ctx.lineTo(xr, y);
        on = true;
      }
      ctx.stroke();
    },
    area(ctx, S, values, base, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      let started = false, lastI = null;
      for (let i = S.i0; i <= S.i1; i++) {
        if (values[i] == null) continue;
        const x = S.x(i), y = S.y(values[i]);
        if (!started) { ctx.moveTo(x, S.y(base)); started = true; }
        ctx.lineTo(x, y);
        lastI = i;
      }
      if (lastI != null) { ctx.lineTo(S.x(lastI), S.y(base)); ctx.closePath(); ctx.fill(); }
    },
    candles(ctx, S, d, up, down) {
      const w = Math.max(1, Math.min(12, S.barW * 0.7));
      for (let i = S.i0; i <= S.i1; i++) {
        const o = d.open[i], c = d.close[i], h = d.high[i], l = d.low[i];
        const col = c >= o ? up : down;
        const x = Math.round(S.x(i));
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 0.5, S.y(h)); ctx.lineTo(x + 0.5, S.y(l)); ctx.stroke();
        const y1 = S.y(Math.max(o, c)), y2 = S.y(Math.min(o, c));
        const bh = Math.max(1, y2 - y1);
        if (c >= o && w >= 4) { // hollow up-candles: shape as well as colour tells direction
          ctx.fillStyle = css("--surface-1");
          ctx.fillRect(x - w / 2 + 0.5, y1, w, bh);
          ctx.strokeRect(x - w / 2 + 0.5, y1 + 0.5, w - 1, Math.max(0, bh - 1));
        } else {
          ctx.fillRect(x - w / 2 + 0.5, y1, w, bh);
        }
      }
    },
    bars(ctx, S, values, colorFn, base = 0) {
      const w = Math.max(1, Math.min(24, S.barW - 2));
      for (let i = S.i0; i <= S.i1; i++) {
        const v = values[i];
        if (v == null) continue;
        ctx.fillStyle = colorFn(i, v);
        const y0 = S.y(base), y1 = S.y(v);
        ctx.fillRect(S.x(i) - w / 2, Math.min(y0, y1), w, Math.max(1, Math.abs(y1 - y0)));
      }
    },
    triangle(ctx, x, y, dir, color, hollow, size = 5) {
      ctx.beginPath();
      if (dir === "up") { ctx.moveTo(x, y - size); ctx.lineTo(x + size, y + size); ctx.lineTo(x - size, y + size); }
      else { ctx.moveTo(x, y + size); ctx.lineTo(x + size, y - size); ctx.lineTo(x - size, y - size); }
      ctx.closePath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = hollow ? color : css("--surface-1");
      ctx.stroke();
      if (!hollow) { ctx.fillStyle = color; ctx.fill(); }
      else { ctx.fillStyle = css("--surface-1"); ctx.fill(); ctx.stroke(); }
    },
    hband(ctx, S, lo, hi, color) {
      ctx.fillStyle = color;
      ctx.fillRect(S.left, S.y(hi), S.right - S.left, Math.max(1, S.y(lo) - S.y(hi)));
    },
    hline(ctx, S, v, color, dash, width = 1) {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
      const y = Math.round(S.y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(S.left, y); ctx.lineTo(S.right, y); ctx.stroke();
      ctx.setLineDash([]);
    },
    tag(ctx, x, y, text, bg, fg, align = "right") {
      ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
      const w = ctx.measureText(text).width + 8;
      const left = align === "right" ? x - w : x;
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(left, y - 8, w, 16, 3) : ctx.rect(left, y - 8, w, 16);
      ctx.fill();
      ctx.fillStyle = fg; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(text, left + 4, y + 0.5);
      ctx.font = FONT;
      return w;
    },
  };

  /* ================================================================ LevelDotChart */
  class LevelDotChart {
    constructor(host, { onHoverText } = {}) {
      this.host = host;
      host.classList.add("chart-host");
      this.canvas = document.createElement("canvas");
      this.canvas.className = "chart-canvas";
      this.canvas.setAttribute("role", "img");
      this.tip = document.createElement("div");
      this.tip.className = "chart-tip";
      this.tip.hidden = true;
      host.append(this.canvas, this.tip);
      this.onHoverText = onHoverText;
      this.canvas.addEventListener("pointermove", (e) => this.hoverAt(e));
      this.canvas.addEventListener("pointerdown", (e) => this.hoverAt(e));
      this.canvas.addEventListener("pointerleave", () => { this.hot = null; this.render(); });
      new ResizeObserver(() => this.render()).observe(host);
    }

    setData(runs, price, fmt) {
      this.runs = runs; this.price = price; this.fmt = fmt;
      this.render();
    }

    render() {
      if (!this.runs || !this.host.clientWidth) return;
      const w = this.host.clientWidth, h = 320;
      const ctx = setupCanvas(this.canvas, w, h);
      const L = { left: 8, right: w - 56, top: 12, bottom: h - 28 };
      const all = this.runs.flatMap((r) => [...r.res.supports, ...r.res.resistances]);
      let lo = Math.min(this.price, ...all.map((z) => z.price));
      let hi = Math.max(this.price, ...all.map((z) => z.price));
      const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
      const y = (v) => L.bottom - ((v - lo) / (hi - lo)) * (L.bottom - L.top);
      const colW = (L.right - L.left) / this.runs.length;
      const x = (k) => L.left + colW * (k + 0.5);
      ctx.fillStyle = css("--surface-1"); ctx.fillRect(0, 0, w, h);
      ctx.font = FONT;
      ctx.strokeStyle = css("--grid"); ctx.fillStyle = css("--text-muted");
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      for (const t of niceTicks(lo, hi, 6)) {
        const ty = Math.round(y(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(L.left, ty); ctx.lineTo(L.right, ty); ctx.stroke();
        ctx.fillText("$" + t, L.right + 6, ty);
      }
      // current price
      ctx.strokeStyle = css("--text-secondary"); ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(L.left, Math.round(y(this.price)) + 0.5); ctx.lineTo(L.right, Math.round(y(this.price)) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
      draw.tag(ctx, L.right + 2, y(this.price), this.fmt(this.price), css("--text-primary"), css("--surface-1"), "left");
      ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = css("--text-secondary");
      const names = { 21: "1 month", 63: "3 months", 126: "6 months", 189: "9 months", 252: "12 months" };
      this.pts = [];
      this.runs.forEach((r, k) => {
        ctx.fillStyle = css("--text-secondary"); ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(names[r.window] || `${r.window} sessions`, x(k), L.bottom + 8);
        const zs = [...r.res.supports, ...r.res.resistances];
        for (const z of zs) {
          const rad = 4 + (z.score / 100) * 6;
          const px = x(k), py = y(z.price);
          const col = z.role === "support" ? css("--support") : css("--resistance");
          const hot = this.hot && this.hot.z === z;
          if (z.windowsSeen >= 3) { // recurring level: outer ring
            ctx.strokeStyle = col; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(px, py, rad + 4, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.beginPath(); ctx.arc(px, py, rad + (hot ? 2 : 0), 0, Math.PI * 2);
          ctx.fillStyle = col; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = css("--surface-1"); ctx.stroke();
          this.pts.push({ x: px, y: py, r: rad + 6, z, w: r.window });
        }
      });
      ctx.strokeStyle = css("--axis");
      ctx.beginPath(); ctx.moveTo(L.left, L.bottom + 0.5); ctx.lineTo(L.right, L.bottom + 0.5); ctx.stroke();
      this.renderTip();
    }

    hoverAt(e) {
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let best = null, bd = 1e9;
      for (const p of this.pts || []) {
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < Math.max(p.r, 12) && d < bd) { bd = d; best = p; }
      }
      if (best?.z !== this.hot?.z) { this.hot = best; this.render(); }
    }

    renderTip() {
      const p = this.hot;
      if (!p) { this.tip.hidden = true; return; }
      this.tip.innerHTML = this.onHoverText(p.z, p.w);
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      let left = p.x + 14;
      if (left + tw > this.host.clientWidth) left = p.x - 14 - tw;
      this.tip.style.left = Math.max(0, left) + "px";
      this.tip.style.top = Math.max(0, p.y - 20) + "px";
    }
  }

  root.Charts = { StackChart, LevelDotChart, draw, niceTicks, withAlpha, css };
})(window);
