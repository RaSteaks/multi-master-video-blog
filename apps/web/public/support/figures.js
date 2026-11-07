// Station figures: one drawing per stop, driven by that figure's own scroll
// position. Formulas are computed (CIE 1931, ST 2084, BT.2100 HLG, BT.2390,
// ICtCp); everything else is an illustration labelled as such in its caption.
// No libraries, network requests or media decoding. The device check calls
// only local capability APIs, and only when the reader asks for it.
(() => {
  const figures = [...document.querySelectorAll(".fig[data-fig]")];
  if (!figures.length || !window.HTMLCanvasElement) return;

  // WebKit can run this deferred script before the stylesheet's custom properties
  // resolve, so every token has a fallback equal to its CSS value and is re-read
  // on each measure.
  const TOKENS = { text: ["--text", "#e2e8ee"], body: ["--body", "#c4ced8"], sec: ["--secondary", "#9aaabb"], ahead: ["--track-ahead", "#5d6b7b"],
    lab: ["--label-ahead", "#8a98a6"], line: ["--line-light", "#2c3840"], focus: ["--focus", "#86b8dc"], bg: ["--background", "#0c0e10"] };
  const C = {};
  function readTokens() {
    const root = getComputedStyle(document.documentElement);
    for (const [key, [name, fallback]] of Object.entries(TOKENS)) C[key] = root.getPropertyValue(name).trim() || fallback;
  }
  readTokens();
  const MONO = '"JetBrains Mono", "IBM Plex Mono", ui-monospace, Consolas, monospace';
  const SANS = 'Inter, ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const span = (p, a, b) => clamp((p - a) / (b - a));
  const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- drawing ----------
  function painter(ctx) {
    const stroke = (color, width, dash, alpha) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.globalAlpha = alpha ?? 1;
    };
    return {
      line(points, { color = C.sec, width = 1, dash, alpha, close = false } = {}) {
        if (points.length < 2) return;
        stroke(color, width, dash, alpha);
        ctx.beginPath();
        points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
        if (close) ctx.closePath();
        ctx.stroke(); ctx.globalAlpha = 1;
      },
      seg(x1, y1, x2, y2, options) { this.line([[x1, y1], [x2, y2]], options); },
      rect(x, y, w, h, { stroke: color, fill, width = 1, dash, radius = 3, alpha } = {}) {
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, radius) : ctx.rect(x, y, w, h);
        if (fill) { ctx.globalAlpha = alpha ?? 1; ctx.fillStyle = fill; ctx.fill(); ctx.globalAlpha = 1; }
        if (color) { stroke(color, width, dash, alpha); ctx.stroke(); ctx.globalAlpha = 1; }
      },
      dot(x, y, r, { fill, stroke: color, width = 1.5, alpha } = {}) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        if (fill) { ctx.globalAlpha = alpha ?? 1; ctx.fillStyle = fill; ctx.fill(); ctx.globalAlpha = 1; }
        if (color) { stroke(color, width, null, alpha); ctx.stroke(); ctx.globalAlpha = 1; }
      },
      text(value, x, y, { size = 11, font = MONO, color = C.sec, align = "left", base = "alphabetic", weight = 400, alpha } = {}) {
        ctx.font = `${weight} ${size}px ${font}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
        ctx.globalAlpha = alpha ?? 1; ctx.fillText(value, x, y); ctx.globalAlpha = 1;
      },
      width(value, size = 11, font = MONO, weight = 400) { ctx.font = `${weight} ${size}px ${font}`; return ctx.measureText(value).width; },
      check(x, y, s, color = C.text) { this.line([[x, y + s * .5], [x + s * .38, y + s * .88], [x + s, y + s * .1]], { color, width: 1.6 }); },
      cross(x, y, s, color = C.text) { this.seg(x, y, x + s, y + s, { color, width: 1.6 }); this.seg(x + s, y, x, y + s, { color, width: 1.6 }); },
      arrow(x1, y1, x2, y2, options = {}) {
        this.seg(x1, y1, x2, y2, options);
        const angle = Math.atan2(y2 - y1, x2 - x1), size = options.head || 6;
        this.line([[x2 - size * Math.cos(angle - .45), y2 - size * Math.sin(angle - .45)], [x2, y2],
          [x2 - size * Math.cos(angle + .45), y2 - size * Math.sin(angle + .45)]], { ...options, dash: [] });
      },
    };
  }

  // ---------- colour science ----------
  const mul = (m, [a, b, c]) => [m[0][0] * a + m[0][1] * b + m[0][2] * c, m[1][0] * a + m[1][1] * b + m[1][2] * c, m[2][0] * a + m[2][1] * b + m[2][2] * c];
  const mmul = (A, B) => A.map(row => [0, 1, 2].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  function inverse(m) {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
    const det = a * A + b * B + c * Cc;
    return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
      [Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
  }
  const RGB2020_TO_XYZ = [[0.636958, 0.1446169, 0.168881], [0.2627002, 0.6779981, 0.0593017], [0, 0.0280727, 1.0609851]];
  const RGB709_TO_XYZ = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]];
  const R709_TO_2020 = mmul(inverse(RGB2020_TO_XYZ), RGB709_TO_XYZ);
  const R2020_TO_709 = inverse(R709_TO_2020);
  const LMS = [[1688, 2146, 262], [683, 2951, 462], [99, 309, 3688]].map(row => row.map(x => x / 4096));
  const ICTCP = [[.5, .5, 0], [6610 / 4096, -13613 / 4096, 7003 / 4096], [17933 / 4096, -17390 / 4096, -543 / 4096]];
  const LMS_INV = inverse(LMS), ICTCP_INV = inverse(ICTCP);
  const PQ = { m1: 2610 / 16384, m2: 2523 / 32, c1: 3424 / 4096, c2: 2413 / 128, c3: 2392 / 128 };
  const pq = nits => { const y = Math.pow(Math.max(0, nits) / 10000, PQ.m1); return Math.pow((PQ.c1 + PQ.c2 * y) / (1 + PQ.c3 * y), PQ.m2); };
  const pqNits = e => { const p = Math.pow(Math.max(0, e), 1 / PQ.m2); return 10000 * Math.pow(Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p), 1 / PQ.m1); };
  const toIctcp = rgb2020Nits => mul(ICTCP, mul(LMS, rgb2020Nits).map(pq));
  const fromIctcp = v => mul(LMS_INV, mul(ICTCP_INV, v).map(pqNits));
  // BT.2100 HLG inverse OETF and the display system gamma for a given peak.
  const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 };
  const hlgScene = e => e <= .5 ? e * e / 3 : (Math.exp((e - HLG.c) / HLG.a) + HLG.b) / 12;
  const hlgGamma = peak => 1.2 + 0.42 * Math.log10(peak / 1000);
  // Colour where colour is the data. A chromaticity is shown at full brightness;
  // anything outside sRGB is desaturated toward white until it fits, so every
  // swatch is an sRGB approximation (the captions say so).
  const XYZ_TO_709 = inverse(RGB709_TO_XYZ);
  const srgbEncode = c => c <= .0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - .055;
  // Marks (dots, edges) also get a luminance floor, mixed toward white, so even
  // sRGB blue keeps 3:1 against the plate without changing its hue family.
  const MARK_MIN_Y = .16;
  function displayRgb(lin709, minY = 0) {
    const low = Math.min(...lin709), shifted = low < 0 ? lin709.map(c => c - low) : lin709;
    const high = Math.max(...shifted) || 1;
    let rgb = shifted.map(c => clamp(c / high));
    const y = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    if (y < minY) { const k = (minY - y) / (1 - y); rgb = rgb.map(c => c + k * (1 - c)); }
    return rgb.map(c => Math.round(255 * srgbEncode(c)));
  }
  const cssRgb = ([r, g, b]) => `rgb(${r},${g},${b})`;
  const xyColor = ([x, y], minY = 0) => displayRgb(mul(XYZ_TO_709, [x / y, 1, (1 - x - y) / y]), minY);
  const rgb2020Color = lin => cssRgb(displayRgb(mul(R2020_TO_709, lin), MARK_MIN_Y));

  // CIE 1931 2° spectral locus (x, y), 380–700 nm.
  const LOCUS = [[.1741, .005], [.1738, .0049], [.1733, .0048], [.1726, .0048], [.1714, .0051], [.1689, .0069], [.1644, .0109], [.1566, .0177],
    [.144, .0297], [.1241, .0578], [.1096, .0868], [.0913, .1327], [.0687, .2007], [.0454, .295], [.0235, .4127], [.0082, .5384],
    [.0039, .6548], [.0139, .7502], [.0389, .812], [.0743, .8338], [.1142, .8262], [.1547, .8059], [.1929, .7816], [.2296, .7543],
    [.2658, .7243], [.3016, .6923], [.3373, .6589], [.3731, .6245], [.4087, .5896], [.4441, .5547], [.4788, .5202], [.5125, .4866],
    [.5448, .4544], [.5752, .4242], [.6029, .3965], [.627, .3725], [.6658, .334], [.6915, .3083], [.7079, .292], [.719, .2809],
    [.726, .274], [.73, .27], [.7334, .2666], [.7347, .2653]];
  const GAMUT = {
    rec709: { label: "BT.709", rgb: [[.64, .33], [.3, .6], [.15, .06]] },
    p3: { label: "P3-D65", rgb: [[.68, .32], [.265, .69], [.15, .06]] },
    rec2020: { label: "BT.2020", rgb: [[.708, .292], [.17, .797], [.131, .046]] },
  };
  const D65 = [.3127, .329];

  // xy plot frame: equal units on both axes, fitted into a box.
  function xyFrame(x, y, w, h) {
    const scale = Math.min(w / .8, h / .9);
    const ox = x + (w - .8 * scale) / 2, oy = y + h - (h - .9 * scale) / 2;
    return { scale, map: ([u, v]) => [ox + u * scale, oy - v * scale], ox, oy };
  }
  function drawXyGrid(g, frame) {
    for (let i = 1; i <= 8; i++) g.seg(...frame.map([i / 10, 0]), ...frame.map([i / 10, .9]), { color: C.line, alpha: .55 });
    for (let i = 1; i <= 9; i++) g.seg(...frame.map([0, i / 10]), ...frame.map([.8, i / 10]), { color: C.line, alpha: .55 });
    g.seg(...frame.map([0, 0]), ...frame.map([.8, 0]), { color: C.ahead });
    g.seg(...frame.map([0, 0]), ...frame.map([0, .9]), { color: C.ahead });
    [.2, .4, .6].forEach(v => {
      const [x0, y0] = frame.map([v, 0]); g.text(v.toFixed(1), x0, y0 + 14, { align: "center", color: C.lab });
      const [x1, y1] = frame.map([0, v]); g.text(v.toFixed(1), x1 - 5, y1 + 4, { align: "right", color: C.lab });
    });
    const [ax, ay] = frame.map([.8, 0]); g.text("x", ax, ay + 14, { align: "right", color: C.sec });
    const [bx, by] = frame.map([0, .9]); g.text("y", bx - 5, by + 9, { align: "right", color: C.sec });
  }
  function drawLocus(g, frame, t) {
    const count = Math.max(2, Math.round(LOCUS.length * t));
    g.line(LOCUS.slice(0, count).map(frame.map), { color: C.sec, width: 1.4 });
    if (t >= 1) g.seg(...frame.map(LOCUS[0]), ...frame.map(LOCUS[LOCUS.length - 1]), { color: C.ahead });
  }
  function triangle(g, frame, gamut, t, options) {
    if (t <= 0) return;
    const pts = gamut.rgb.concat([gamut.rgb[0]]).map(frame.map);
    const total = 3 * t, out = [pts[0]];
    for (let i = 0; i < 3 && i < total; i++) {
      const f = Math.min(1, total - i);
      out.push([lerp(pts[i][0], pts[i + 1][0], f), lerp(pts[i][1], pts[i + 1][1], f)]);
    }
    g.line(out, options);
  }

  // ---------- figure definitions ----------
  // Line grammar inside figures follows the map: --text for what is current or
  // resulting, --secondary for references, --track-ahead for what is not yet
  // reached or only a ghost; dashed means the SDR branch, dotted a fallback. The
  // accent marks only the playhead, in-flight work and the current step.
  const DEFS = {
    // P1: chunked upload with an interruption and resume.
    p1: {
      draw(g, w, h, p, f) {
        const total = 48, cut = 21, narrow = w < 480, pad = 18;
        const cols = narrow ? 12 : 16, rows = total / cols, gap = 4;
        const cell = Math.min((w - pad * 2 - gap * (cols - 1)) / cols, 30);
        const gridW = cols * cell + (cols - 1) * gap, gridH = rows * cell + (rows - 1) * gap;
        const gx = pad, gy = 62;
        g.text("示例文件 48 MiB · 1 MiB 分块", pad, 28, { font: SANS, size: 12, color: C.body });
        const interrupt = f.state.interrupt;
        let confirmed, inflight = -1, failed = -1, sub = 0, phase;
        if (!interrupt) {
          const t = span(p, 0, .88) * total; confirmed = Math.min(total, Math.floor(t)); sub = t - confirmed;
          phase = confirmed >= total ? "done" : "up";
        } else if (p < .42) {
          const t = span(p, 0, .42) * cut; confirmed = Math.floor(t); sub = t - confirmed; phase = "up";
        } else if (p < .55) {
          confirmed = cut; failed = cut; phase = "lost";
        } else {
          const t = cut + span(p, .55, .88) * (total - cut); confirmed = Math.min(total, Math.floor(t)); sub = t - confirmed;
          phase = confirmed >= total ? "done" : "resume";
        }
        if (phase === "up" || phase === "resume") inflight = confirmed;
        for (let i = 0; i < total; i++) {
          const x = gx + (i % cols) * (cell + gap), y = gy + Math.floor(i / cols) * (cell + gap);
          if (i < confirmed) {
            const kept = interrupt && phase !== "up" && i < cut;
            g.rect(x, y, cell, cell, { fill: C.sec, radius: 2, alpha: kept ? .5 : .9 });
            if (interrupt && phase !== "up" && i === cut) g.rect(x - 1.5, y - 1.5, cell + 3, cell + 3, { stroke: C.text, width: 1.4, radius: 3 });
          }
          else if (i === inflight) {
            g.rect(x, y, cell, cell, { stroke: C.focus, width: 1.5, radius: 2 });
            g.rect(x + 2, y + 2, Math.max(0, (cell - 4) * sub), cell - 4, { fill: C.focus, radius: 1, alpha: .55 });
          } else if (i === failed) {
            g.rect(x, y, cell, cell, { stroke: C.text, width: 1.2, radius: 2 });
            g.cross(x + cell * .3, y + cell * .3, cell * .4, C.text);
          } else g.rect(x, y, cell, cell, { stroke: C.line, radius: 2 });
        }
        if (interrupt && phase !== "up") {
          const x = gx + (cut % cols) * (cell + gap) + cell / 2, y = gy + Math.floor(cut / cols) * (cell + gap);
          g.seg(x, gy - 10, x, y - 3, { color: C.text, width: 1.2 });
          const label = phase === "lost" ? "断点" : "从第 22 块继续";
          const right = x + g.width(label, 11, SANS) > w - pad;
          g.text(label, right ? x + 4 : x - 4, gy - 14, { font: SANS, size: 11, color: C.text, align: right ? "right" : "left" });
        }
        const bottom = gy + gridH, done = phase === "done";
        g.text(`已确认 ${String(confirmed).padStart(2, "0")} / 48 MiB`, pad, bottom + 30, { color: C.text, size: 12 });
        if (interrupt && phase !== "up" && !narrow) g.text("较暗：断线前已确认 · 较亮：续传后上传", pad, bottom + 50, { font: SANS, size: 11, color: C.sec });
        const qw = narrow ? w - pad * 2 : 196, qx = narrow ? pad : gx + gridW - qw, qy = narrow ? bottom + 46 : bottom + 12, qh = 44;
        g.rect(qx, qy, qw, qh, { stroke: done ? C.text : C.line, radius: 6, width: done ? 1.4 : 1 });
        g.text("后台处理队列", qx + 12, qy + 19, { font: SANS, size: 12, color: done ? C.text : C.lab, weight: done ? 600 : 400 });
        g.text("探测 · 验证 · 封装", qx + 12, qy + 36, { font: SANS, size: 11, color: done ? C.sec : C.lab });
        if (done && !narrow) g.arrow(qx + qw / 2, bottom + 2, qx + qw / 2, qy - 2, { color: C.text, head: 4 });
        return { up: `上传中 · 第 ${inflight + 1} 块`, lost: "连接中断 · 已确认的 21 块留在服务器", resume: `续传 · 第 ${inflight + 1} 块`, done: "48 / 48 已确认 → 进入后台处理队列" }[phase];
      },
    },

    // P2: stream fields, 32-packet sampling and a full RPU scan.
    p2: {
      draw(g, w, h, p) {
        const narrow = w < 480, pad = 18;
        const fields = [["codec_name", "hevc"], ["profile", "Main 10"], ["pix_fmt", "yuv420p10le"], ["color_primaries", "bt2020"],
          ["color_transfer", "smpte2084"], ["color_space", "bt2020nc"], ["color_range", "tv"]];
        const rowH = narrow ? 15 : 22;
        g.text("流信息（示例）", pad, 28, { font: SANS, size: 12, color: C.body });
        fields.forEach(([key, value], i) => {
          const t = span(p, .03 + i * .045, .07 + i * .045);
          if (t <= 0) return;
          const y = 50 + i * rowH;
          g.text(key, pad, y, { color: C.sec, alpha: t });
          g.text(value, pad + (narrow ? 128 : 132), y, { color: C.text, alpha: t });
        });
        const rx = narrow ? pad : w * .47, rw = w - rx - pad;
        let y = narrow ? 50 + 7 * rowH + 22 : 50;
        const sampled = span(p, .36, .58);
        g.text("抽样解码 · 开头 32 个 packet", rx, y - 10 + (narrow ? 0 : -12), { font: SANS, size: 12, color: sampled > 0 ? C.body : C.lab });
        const tick = rw / 32;
        for (let i = 0; i < 32; i++) {
          const on = i < Math.round(32 * sampled), x = rx + i * tick + tick / 2;
          g.seg(x, y, x, y + 16, { color: on ? C.text : C.line, width: Math.max(1, tick * .35) });
          if ((i === 0 || i === 24) && on) g.dot(x, y + 24, 2.6, { fill: C.text });
        }
        if (sampled > 0 && sampled < 1) { const x = rx + rw * sampled; g.seg(x, y - 4, x, y + 20, { color: C.focus, width: 2 }); }
        y += narrow ? 40 : 44;
        if (sampled >= 1) {
          g.text("Mastering display metadata", rx, y, { color: C.text });
          g.text("Content light level metadata", rx, y + 16, { color: C.text });
          g.text("MaxCLL 1000 / MaxFALL 400", rx, y + 32, { color: C.sec });
        }
        y += narrow ? 58 : 64;
        const scan = span(p, .62, .92);
        g.text("Dolby Vision · 扫描完整码流的 RPU", rx, y, { font: SANS, size: 12, color: scan > 0 ? C.body : C.lab });
        y += 12;
        g.rect(rx, y, rw, 8, { stroke: C.line, radius: 2 });
        g.rect(rx, y, rw * scan, 8, { fill: C.sec, radius: 2, alpha: .85 });
        if (scan > 0 && scan < 1) g.seg(rx + rw * scan, y - 4, rx + rw * scan, y + 12, { color: C.focus, width: 2 });
        y += 26;
        g.text(`RPU ${String(Math.round(1440 * scan)).padStart(4, " ")} / 1440`, rx, y, { color: scan > 0 ? C.text : C.lab });
        const hash = "9c4e1b07a3f28d56e0b4c19f7a2d63e85b1f0c94d7e2a6b3f81c05e9d4a7b260";
        const shown = Math.round(64 * span(p, .8, .98));
        if (shown > 0) {
          if (narrow) g.text(`SHA-256 ${hash.slice(0, Math.min(shown, 10))}${shown > 10 ? "…" + hash.slice(64 - Math.min(8, shown - 10)) : ""}`, rx, y + 18, { color: C.sec });
          else {
            g.text("SHA-256", rx, y + 20, { color: C.sec });
            g.text(hash.slice(0, Math.min(shown, 32)), rx + 64, y + 20, { color: C.text });
            if (shown > 32) g.text(hash.slice(32, shown), rx + 64, y + 36, { color: C.text });
          }
        }
        if (p < .36) return "读取流信息";
        if (p < .62) return "抽样解码，查找帧附加信息";
        return scan < 1 ? "扫描完整码流中的 RPU" : "记录 RPU 数量与 SHA-256";
      },
    },

    // C1: what encoded primaries mean, against the spectral locus.
    c1: {
      cache: null,
      // The horseshoe fill, computed once per plot size at CSS-pixel resolution.
      fill(frame) {
        const w = Math.max(1, Math.round(.8 * frame.scale)), h = Math.max(1, Math.round(.9 * frame.scale));
        if (this.cache && this.cache.w === w && this.cache.h === h) return this.cache.canvas;
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d"), image = ctx.createImageData(w, h);
        for (let j = 0; j < h; j++) {
          const y = .9 * (1 - (j + .5) / h);
          if (y < .003) continue;
          for (let i = 0; i < w; i++) {
            const [r, g, b] = xyColor([.8 * (i + .5) / w, y]), k = (j * w + i) * 4;
            image.data[k] = r; image.data[k + 1] = g; image.data[k + 2] = b; image.data[k + 3] = 255;
          }
        }
        ctx.putImageData(image, 0, 0);
        this.cache = { w, h, canvas };
        return canvas;
      },
      draw(g, w, h, p, f) {
        const pad = 18, narrow = w < 480;
        const frame = xyFrame(pad + 22, pad, (narrow ? w - pad * 2 : w * .62) - 22, h - pad * 2 - 14);
        const reveal = span(p, 0, .22);
        if (reveal > 0) {
          const path = new Path2D();
          LOCUS.forEach((point, i) => { const [x, y] = frame.map(point); i ? path.lineTo(x, y) : path.moveTo(x, y); });
          path.closePath();
          f.ctx.save(); f.ctx.clip(path); f.ctx.globalAlpha = .36 * reveal;
          f.ctx.drawImage(this.fill(frame), frame.ox, frame.oy - .9 * frame.scale, .8 * frame.scale, .9 * frame.scale);
          f.ctx.restore();
        }
        drawXyGrid(g, frame);
        drawLocus(g, frame, reveal);
        const pick = f.state.gamut || "rec2020";
        const tEnc = ease(span(p, .22, .45)), tCmp = ease(span(p, .45, .62)), tMaster = ease(span(p, .66, .86));
        Object.entries(GAMUT).forEach(([id, gamut]) => {
          if (id === pick) return;
          triangle(g, frame, gamut, tCmp, { color: C.bg, width: 3.4, alpha: .55 });
          triangle(g, frame, gamut, tCmp, { color: C.lab, width: 1.2 });
        });
        triangle(g, frame, GAMUT.p3, tMaster, { color: C.body, width: 1.3 });
        if (tMaster > 0) GAMUT.p3.rgb.forEach(v => g.dot(...frame.map(v), 3, { fill: C.body, stroke: C.bg, width: 1, alpha: tMaster }));
        triangle(g, frame, GAMUT[pick], tEnc, { color: C.text, width: 2 });
        if (tEnc > .5) g.dot(...frame.map(D65), 3.4, { fill: C.text, stroke: C.bg, width: 1.5 });
        const lx = narrow ? frame.map([.43, 0])[0] : w * .62 + 26, ly = narrow ? frame.map([0, .86])[1] : pad + 22, lh = narrow ? 17 : 22;
        const rows = [[`编码原色 ${GAMUT[pick].label}`, C.text, 2, tEnc, false], ["对比色域", C.lab, 1.1, tCmp, false],
          [`母版监视器 P3-D65${narrow ? "" : "（示例）"}`, C.body, 1.3, tMaster, true]];
        rows.forEach(([label, color, width, t, dots], i) => {
          if (t <= 0) return;
          g.seg(lx, ly + i * lh - 4, lx + 20, ly + i * lh - 4, { color, width, alpha: t });
          if (dots) { g.dot(lx, ly + i * lh - 4, 2.4, { fill: color, alpha: t }); g.dot(lx + 20, ly + i * lh - 4, 2.4, { fill: color, alpha: t }); }
          g.text(label, lx + 28, ly + i * lh, { font: SANS, size: 11.5, color: C.body, alpha: t });
        });
        if (!narrow && tEnc > 0) {
          const g0 = GAMUT[pick].rgb;
          let y = ly + 3 * lh + 14;
          ["R", "G", "B"].forEach((name, i) => { g.text(`${name}  ${g0[i][0].toFixed(3)}, ${g0[i][1].toFixed(3)}`, lx, y, { color: C.sec, alpha: tEnc }); y += 17; });
          g.text("W  0.3127, 0.3290  D65", lx, y, { color: C.sec, alpha: tEnc });
          if (tMaster > 0) g.text("MaxCLL 1000 · MaxFALL 400（示例）", lx, y + 28, { font: SANS, size: 11.5, color: C.body, alpha: tMaster });
        }
        if (p < .22) return "CIE 1931 xy · 光谱轨迹";
        if (p < .45) return `编码原色 ${GAMUT[pick].label}：定义信号的色域`;
        if (p < .66) return pick === "rec709" ? "宽色域也可以用于 SDR；HEVC 或 10-bit 不能证明 HDR" : "色域越宽，三角形越大；它不代表屏幕能覆盖";
        return "母版监视器原色是另一份信息，与编码原色不同";
      },
    },

    // P3: 4 s target cut points snapping to the next keyframe.
    p3: {
      draw(g, w, h, p) {
        const pad = 18, narrow = w < 480;
        const keys = [0, 2, 4.2, 6.2, 8, 10, 12.6, 14.6, 16, 18, 20.3, 22.3, 24];
        const cuts = [0, 4.2, 8, 12.6, 16, 20.3, 24];
        const x0 = pad, x1 = w - pad, tx = t => x0 + (x1 - x0) * t / 24;
        const axisY = narrow ? 96 : 112;
        const head = 24 * span(p, 0, .55);
        g.text("示例时间线 · 目标每 4 秒一切", pad, 28, { font: SANS, size: 12, color: C.body });
        g.seg(x1 - 46, 20, x1 - 46, 30, { color: C.text, width: 2 });
        g.text("关键帧", x1, 30, { align: "right", color: C.sec, font: SANS, size: 11 });
        g.seg(x0, axisY, x1, axisY, { color: C.ahead });
        for (let s = 0; s <= 24; s += 4) {
          g.seg(tx(s), axisY - 46, tx(s), axisY + 4, { color: C.ahead, dash: [.1, 4], width: 1.4 });
          g.text(`${s}s`, tx(s), axisY + 18, { align: "center", color: C.lab });
        }
        keys.forEach(k => g.seg(tx(k), axisY - 10, tx(k), axisY, { color: k <= head ? C.text : C.ahead, width: 2 }));
        for (let i = 0; i < cuts.length - 1; i++) {
          if (cuts[i] > head) break;
          const end = Math.min(cuts[i + 1], head), complete = head >= cuts[i + 1];
          g.rect(tx(cuts[i]) + 1, axisY - 40, tx(end) - tx(cuts[i]) - 2, 22, { stroke: complete ? C.sec : C.focus, radius: 3 });
          if (complete) {
            g.text(`${(cuts[i + 1] - cuts[i]).toFixed(1)}s`, (tx(cuts[i]) + tx(end)) / 2, axisY - 25, { align: "center", color: C.text, size: narrow ? 10.5 : 11 });
            if (cuts[i + 1] < 24) g.seg(tx(cuts[i + 1]), axisY - 46, tx(cuts[i + 1]), axisY + 4, { color: C.text, width: 1.4 });
          }
        }
        if (head < 24) g.seg(tx(head), axisY - 50, tx(head), axisY + 6, { color: C.focus, width: 2 });
        const files = [["master.m3u8", "多变体清单"], ["media.m3u8", "媒体列表"], ["init.mp4", "初始化分段"], ["segment_000–005.m4s", "6 个 fMP4 分段"]];
        const fy = axisY + (narrow ? 46 : 52), filesT = span(p, .55, .78);
        files.forEach(([name, note], i) => {
          const t = span(filesT, i / 4, (i + 1) / 4);
          if (t <= 0) return;
          g.text(name, pad, fy + i * 19, { color: C.text, alpha: t });
          g.text(note, pad + (narrow ? 172 : 170), fy + i * 19, { font: SANS, size: 11, color: C.sec, alpha: t });
        });
        const checks = ["色彩字段一致", "静态元数据一致", "RPU 数量与哈希一致"];
        const verify = span(p, .8, .95);
        const vx = narrow ? pad : w * .58, vy = narrow ? fy + 4 * 19 + 14 : fy - 2;
        g.text("重新探测输出", vx, vy, { font: SANS, size: 12, color: verify > 0 ? C.body : C.lab });
        checks.forEach((label, i) => {
          if (verify * 3 <= i) return;
          g.check(vx, vy + 10 + i * 19, 10, C.text);
          g.text(label, vx + 18, vy + 19 + i * 19, { font: SANS, size: 11.5, color: C.text });
        });
        const ready = p >= .96;
        const cx = narrow ? w - pad - 64 : vx, cy = narrow ? vy - 16 : vy + 10 + 3 * 19 + 8;
        if (verify > 0) {
          g.rect(cx, cy, 64, 24, { stroke: ready ? C.text : C.line, radius: 12, width: ready ? 1.4 : 1 });
          g.text("ready", cx + 32, cy + 16, { align: "center", color: ready ? C.text : C.lab, weight: ready ? 600 : 400 });
        }
        if (p < .55) return head < 24 ? `播放头 ${head.toFixed(1)}s · 到达目标后切在下一个关键帧` : "切分完成";
        if (p < .8) return "生成清单、初始化分段与 fMP4 分段";
        return ready ? "验证通过并完成发布 → ready" : "重新探测输出，逐项对照";
      },
    },

    // C2: input/output comparison and the three layers of information.
    c2: {
      draw(g, w, h, p) {
        const pad = 18, narrow = w < 480;
        const rows = [["color_primaries", "bt2020", "bt2020"], ["color_transfer", "smpte2084", "smpte2084"],
          ["Mastering display", "P3-D65 · 1000", "P3-D65 · 1000"], ["MaxCLL / MaxFALL", "1000 / 400", "1000 / 400"],
          ["RPU 数量", "1440", "1440"], ["RPU SHA-256", "9c4e1b07…", "9c4e1b07…"]];
        const c1 = narrow ? pad + 128 : pad + 160, c2 = pad + 300, c3 = w - pad - 12;
        g.text("字段（示例）", pad, 28, { font: SANS, size: 11.5, color: C.sec });
        g.text(narrow ? "输入 = 输出" : "输入", c1, 28, { font: SANS, size: 11.5, color: C.sec });
        if (!narrow) g.text("输出", c2, 28, { font: SANS, size: 11.5, color: C.sec });
        const rowH = narrow ? 18 : 21;
        rows.forEach(([key, a, b], i) => {
          const y = 50 + i * rowH, t = span(p, .05 + i * .07, .1 + i * .07);
          g.text(key, pad, y, { color: C.sec, size: narrow ? 10.5 : 11 });
          g.text(a, c1, y, { color: C.text, size: narrow ? 10.5 : 11 });
          if (!narrow) g.text(b, c2, y, { color: t > 0 ? C.text : C.lab, alpha: Math.max(.35, t) });
          if (t > 0 && t < 1) g.dot(c3 + 3, y - 4, 3, { fill: C.focus });
          if (t >= 1) g.check(c3 - 2, y - 9, 10, C.text);
        });
        const top = 50 + rows.length * rowH + (narrow ? 4 : 10);
        const layers = [["数据库", "展示与选源"], ["HLS 声明", "CODECS · VIDEO-RANGE"], ["媒体内部", "配置 · 色彩标记 · SEI · RPU"]];
        const layerT = ease(span(p, .5, .75)), lh = (h - top - pad) / 3 - 4;
        const lw = narrow ? w - pad * 2 - 72 : w * .62;
        layers.forEach(([name, note], i) => {
          const y = top + i * (lh + 4), inMedia = i === 2, lit = inMedia && p > .78;
          g.rect(pad, y, lw, lh, { stroke: lit ? C.text : C.ahead, radius: 4, alpha: layerT, width: lit ? 1.4 : 1 });
          g.text(name, pad + 10, y + lh / 2 + 4, { font: SANS, size: 12, color: C.text, weight: 600, alpha: layerT });
          g.text(note, pad + (narrow ? 72 : 90), y + lh / 2 + 4, { font: SANS, size: narrow ? 10.5 : 11, color: C.sec, alpha: layerT });
          if (!inMedia && p > .78 && !narrow) g.text("不进入解码", pad + lw + 12, y + lh / 2 + 4, { font: SANS, size: 11, color: C.lab });
        });
        if (p > .78) {
          const y = top + 2 * (lh + 4) + lh / 2;
          g.arrow(pad + lw + 6, y, w - pad - (narrow ? 2 : 96), y, { color: C.text, width: 1.4 });
          if (narrow) g.text("解码", w - pad, y - 8, { font: SANS, size: 11, color: C.text, align: "right" });
          else g.text("解码与显示", w - pad - 88, y + 4, { font: SANS, size: 12, color: C.text });
        }
        if (p < .5) return "输入与输出逐项对照";
        return p > .78 ? "只有媒体内部的元数据随视频进入解码" : "三层信息，各有用途";
      },
    },

    // C6: BT.2020 PQ volume → BT.2390 EETF → BT.709 at 100 cd/m², in ICtCp.
    c6: {
      init(f) {
        f.state.yaw = .6;
        const canvas = f.canvas;
        const announce = () => {
          const degrees = Math.round(((f.state.yaw * 180 / Math.PI) % 360 + 360) % 360);
          canvas.setAttribute("aria-valuenow", String(degrees));
          canvas.setAttribute("aria-valuetext", `旋转 ${degrees}°`);
        };
        announce();
        let drag = null;
        canvas.addEventListener("pointerdown", event => { drag = { x: event.clientX, yaw: f.state.yaw }; canvas.setPointerCapture(event.pointerId); canvas.style.cursor = "grabbing"; });
        canvas.addEventListener("pointermove", event => { if (!drag) return; f.state.yaw = drag.yaw + (event.clientX - drag.x) * .01; announce(); render(f); });
        const end = () => { drag = null; canvas.style.cursor = ""; };
        canvas.addEventListener("pointerup", end);
        canvas.addEventListener("pointercancel", end);
        canvas.addEventListener("keydown", event => {
          const step = { ArrowLeft: -.15, ArrowDown: -.15, ArrowRight: .15, ArrowUp: .15 }[event.key];
          if (!step) return;
          event.preventDefault();
          f.state.yaw += step; announce(); render(f);
        });
      },
      model: null,
      build() {
        const SRC = 1000, DST = 100;
        const pqS = pq(SRC), maxLum = pq(DST) / pqS, KS = 1.5 * maxLum - .5;
        const eetf = I => {
          const e1 = I / pqS;
          if (e1 < KS) return I;
          const t = (Math.min(e1, 1) - KS) / (1 - KS), t2 = t * t, t3 = t2 * t;
          return ((2 * t3 - 3 * t2 + 1) * KS + (t3 - 2 * t2 + t) * (1 - KS) + (-2 * t3 + 3 * t2) * maxLum) * pqS;
        };
        const inside709 = v => mul(R2020_TO_709, fromIctcp(v)).every(c => c >= -.05 && c <= DST * 1.0005);
        const lines = [], offsets = [0, 1 / 3, 2 / 3, 1], steps = 16;
        for (let axis = 0; axis < 3; axis++) {
          const u = (axis + 1) % 3, v = (axis + 2) % 3;
          for (const face of [0, 1]) for (const offset of offsets) for (const [fixed, free] of [[u, v], [v, u]]) {
            const points = [];
            for (let s = 0; s <= steps; s++) {
              const rgb = [0, 0, 0]; rgb[axis] = face; rgb[fixed] = offset; rgb[free] = s / steps;
              points.push(rgb);
            }
            lines.push({ points, edge: offset === 0 || offset === 1 });
          }
        }
        const encode = rgb => rgb.map(c => Math.pow(c, 2.4));
        const source = lines.map(line => ({ edge: line.edge, pts: line.points.map(rgb => toIctcp(encode(rgb).map(c => c * SRC))),
          colors: line.edge ? line.points.map(rgb => rgb2020Color(encode(rgb))) : null }));
        const target = lines.filter(line => line.edge).map(line => line.points.map(rgb => toIctcp(mul(R709_TO_2020, encode(rgb).map(c => c * DST)))));
        const toned = source.map(line => line.pts.map(([I, T, P]) => {
          const I2 = eetf(I), s = I > 1e-6 ? Math.min(I / I2, I2 / I) : 1;
          return [I2, T * s, P * s];
        }));
        const mapped = toned.map(line => line.map(([I, T, P]) => {
          if (inside709([I, T, P])) return [I, T, P];
          let lo = 0, hi = 1;
          for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; inside709([I, T * mid, P * mid]) ? lo = mid : hi = mid; }
          return [I, T * lo, P * lo];
        }));
        let extent = 0;
        source.forEach(line => line.pts.forEach(([, T, P]) => { extent = Math.max(extent, Math.hypot(T, P)); }));
        this.model = { source, toned, mapped, target, extent, pqS, pq100: pq(DST) };
      },
      draw(g, w, h, p, f) {
        if (!this.model) this.build();
        const { source, toned, mapped, target, extent, pqS, pq100 } = this.model;
        const pad = 18, narrow = w < 480;
        const a = ease(span(p, .14, .52)), b = ease(span(p, .58, .9));
        const yaw = f.state.yaw + p * .7, pitch = .32;
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
        // Rotation-invariant framing that always holds the whole 1000 cd/m² source:
        // the black point is achromatic, so only the top needs room for chroma depth.
        const ruler = 64, legendH = narrow ? 40 : 0;
        const left = pad + ruler, right = narrow ? w - pad : w * .72, top = pad + legendH + 8, bottom = h - pad - 6;
        const Imax = pqS;
        const span3 = Imax * cp + extent * sp;
        const scale = Math.min((bottom - top) / span3, (right - left) / (2 * extent));
        const cx = (left + right) / 2, baseY = top + (bottom - top + span3 * scale) / 2;
        const project = ([I, T, P]) => {
          const x = T * cy + P * sy, z = -T * sy + P * cy;
          return [cx + x * scale, baseY - (I * cp + z * sp) * scale, -I * sp + z * cp];
        };
        const strokeLines = (lines, options) => lines.forEach(line => {
          const pts = line.map(project);
          const depth = pts.reduce((sum, q) => sum + q[2], 0) / pts.length;
          g.line(pts, { ...options, alpha: (options.alpha ?? 1) * lerp(1, .42, clamp((depth + extent) / (2 * extent))) });
        });
        // Luminance ruler outside the volume; the achromatic axis carries no labels.
        const rulerX = pad + ruler - 14;
        g.seg(rulerX, baseY, rulerX, baseY - .8 * cp * scale, { color: C.ahead });
        [[1, "1"], [100, "100"], [1000, "1000"]].forEach(([nits, label]) => {
          const y = baseY - pq(nits) * cp * scale;
          g.seg(rulerX - 4, y, rulerX + 4, y, { color: C.sec });
          g.text(label, rulerX - 8, y + 4, { align: "right", color: nits === 100 && b > 0 ? C.text : C.lab });
        });
        g.text("cd/m²", rulerX - 8, baseY - .8 * cp * scale - 6, { align: "right", color: C.sec, size: 10.5 });
        const axisTop = project([.8, 0, 0]), origin = project([0, 0, 0]);
        g.seg(origin[0], origin[1], axisTop[0], axisTop[1], { color: C.line });
        g.text("I", axisTop[0] + 6, axisTop[1] + 4, { color: C.sec });
        [[[0, extent * .9, 0], "Ct"], [[0, 0, extent * .9], "Cp"]].forEach(([v, label]) => {
          const q = project(v);
          g.seg(origin[0], origin[1], q[0], q[1], { color: C.line });
          g.text(label, q[0] + 4, q[1] + 4, { color: C.lab });
        });
        if (f.state.source && a > 0) strokeLines(source.filter(line => line.edge).map(line => line.pts), { color: C.ahead, width: .9, alpha: .7 });
        if (f.state.target) strokeLines(target, { color: C.sec, width: 1 });
        const current = source.map((line, i) => line.pts.map((v, j) => {
          const t = toned[i][j], m = mapped[i][j];
          return [0, 1, 2].map(k => v[k] + a * (t[k] - v[k]) + b * (m[k] - t[k]));
        }));
        strokeLines(current.filter((_, i) => !source[i].edge), { color: C.sec, width: .7, alpha: .4 });
        current.forEach((line, i) => {
          if (!source[i].edge) return;
          const pts = line.map(project), colors = source[i].colors;
          for (let j = 1; j < pts.length; j++) {
            const depth = (pts[j][2] + pts[j - 1][2]) / 2;
            g.seg(pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1], { color: colors[j], width: 1.7, alpha: lerp(1, .45, clamp((depth + extent) / (2 * extent))) });
          }
        });
        // Legend follows the state of the solid.
        const solid = a <= 0 ? "BT.2020 源体积" : b >= 1 ? "映射后" : "映射中";
        const legend = [[solid, C.text, 1.6, true], ["BT.709 · 100 cd/m²", C.sec, 1, f.state.target], ["源体积轮廓", C.ahead, .9, f.state.source && a > 0]].filter(row => row[3]);
        legend.forEach(([label, color, width], i) => {
          const x = narrow ? pad + (i % 2) * (w / 2 - 8) : w * .74, y = narrow ? pad + 10 + Math.floor(i / 2) * 18 : pad + 24 + i * 22;
          if (i === 0) ["rgb(255,60,40)", "rgb(80,230,80)", "rgb(70,110,255)"].forEach((c, k) => g.seg(x + k * 6, y - 4, x + k * 6 + 6, y - 4, { color: c, width: 2 }));
          else g.seg(x, y - 4, x + 18, y - 4, { color, width: width + .4 });
          g.text(label, x + 24, y, { font: SANS, size: 11, color: C.body });
        });
        if (!narrow) {
          g.text("ICtCp · I 为 PQ 编码强度", w * .74, pad + 24 + 3 * 22 + 6, { font: SANS, size: 11, color: C.sec });
          g.text(`白点 ${Math.round(pqNits(lerp(pqS, pq100, a)))} cd/m²`, w * .74, pad + 24 + 4 * 22 + 6, { color: a > 0 ? C.text : C.sec });
        }
        if (p < .14) return "源：BT.2020 · PQ · 峰值 1000 cd/m²（示例）";
        if (p < .58) return "亮度：BT.2390 EETF 把 1000 压到 100 cd/m²";
        return b < 1 ? "色域：沿恒定 I 收进 BT.709（简化示意）" : "落进 BT.709 · 100 cd/m² 体积";
      },
    },

    // P4: the selection order of selectAutomaticMaster; optionally run here.
    p4: {
      init(f) { f.state.result = null; },
      draw(g, w, h, p, f) {
        const pad = 18, narrow = w < 480, result = f.state.result;
        const nodes = [["显示报告 HDR？", "matchMedia · (video-)dynamic-range"], ["候选排序", "默认母版 › Dolby Vision › HDR10 › HLG"],
          ["读取候选的首个 variant", "CODECS · VIDEO-RANGE · 分辨率 · 帧率 · 带宽"], ["decodingInfo()", "supported 且 smooth · 单次 ≤1.5 s · 否则试下一个候选"],
          ["选定第一个通过的母版", "整体选源 ≤5 s · 手动选择优先"]];
        const lit = result ? 5 : p * 5.6;
        const pass = result ? [result.hdr, result.hdr, result.hdr, result.hdr && result.pick !== null, result.hdr && result.pick !== null] : [true, true, true, true, true];
        const gap = 9, loop = 26, bx = pad + loop, bw = narrow ? w - bx - pad - 84 : w * .58, bh = (h - pad * 2 - gap * 4) / 5;
        const box = i => [bx, pad + i * (bh + gap), bw, bh];
        nodes.forEach(([name, note], i) => {
          const [x, y] = box(i), on = lit > i, skipped = result && !pass[i];
          const current = !result && i === Math.min(4, Math.floor(lit));
          g.rect(x, y, bw, bh, { stroke: skipped ? C.ahead : current ? C.focus : on ? C.text : C.line, radius: 6, width: on && !skipped ? 1.4 : 1 });
          const label = i === 4 && result?.pick ? `选定 ${result.pick}` : name;
          const twoLines = bh >= 40, color = skipped ? C.lab : on ? C.text : C.lab;
          g.text(label, x + 12, y + (twoLines ? bh / 2 - 3 : bh / 2 + 4), { font: SANS, size: 12, color, weight: 600 });
          const short = i === 1 ? "默认 › DV › HDR10 › HLG" : note.split(" · ")[0];
          if (twoLines) g.text(narrow ? short : note, x + 12, y + bh / 2 + 13, { font: SANS, size: 11, color: skipped || !on ? C.lab : C.sec });
          if (i < 4) g.arrow(x + 22, y + bh + 1, x + 22, y + bh + gap - 1, { color: lit > i + 1 ? C.text : C.line, head: 3 });
        });
        // Each candidate that fails goes back for the next one.
        const [, y2] = box(2), [, y3] = box(3), loopOn = lit > 3.5;
        g.line([[bx, y3 + bh / 2], [pad + 6, y3 + bh / 2], [pad + 6, y2 + bh / 2], [bx - 2, y2 + bh / 2]], { color: loopOn ? C.sec : C.line, dash: [.1, 4], width: 1.4 });
        g.arrow(pad + 12, y2 + bh / 2, bx - 2, y2 + bh / 2, { color: loopOn ? C.sec : C.line, head: 3 });
        // The SDR branch: no HDR report, or no candidate passed.
        const sx = bx + bw + (narrow ? 12 : 30), sw = w - pad - sx, [, y0] = box(0), [, y4] = box(4);
        const sy = (y0 + y4 + bh) / 2 - 28;
        const sdr = result ? !result.pick || !result.hdr : false;
        g.rect(sx, sy, sw, 56, { stroke: sdr ? C.text : C.sec, dash: [6, 4], radius: 6, width: sdr ? 1.4 : 1 });
        if (narrow) {
          g.text("已验证", sx + 8, sy + 23, { font: SANS, size: 12, color: sdr || p > .2 ? C.text : C.lab, weight: 600 });
          g.text("SDR", sx + 8, sy + 41, { font: SANS, size: 12, color: sdr || p > .2 ? C.text : C.lab, weight: 600 });
        } else g.text("已验证 SDR", sx + 10, sy + 23, { font: SANS, size: 12, color: sdr || p > .2 ? C.text : C.lab, weight: 600 });
        if (!narrow) g.text("未报告 HDR，或没有候选通过", sx + 10, sy + 41, { font: SANS, size: 11, color: C.sec });
        [0, 4].forEach(i => {
          const [x, y] = box(i);
          g.seg(x + bw, y + bh / 2, sx, sy + 28, { color: C.ahead, dash: [6, 4] });
        });
        if (result) return !result.hdr ? "本机未报告 HDR：本站不会查询，直接选已验证 SDR" : result.pick ? `本机（示例配置）：自动选择 ${result.pick}` : "本机（示例配置）：没有候选通过 → 已验证 SDR";
        return ["先确认显示环境报告 HDR", "把 HDR 候选按优先级排序", "逐个读取候选的首个 HLS variant", "按具体配置查询 decodingInfo()", "第一个通过的候选即为结果"][Math.min(4, Math.floor(p * 5))];
      },
      async action(name, f) {
        if (name !== "probe") return;
        const button = f.el.querySelector("[data-action='probe']"), out = f.el.querySelector(".fig-results");
        button.disabled = true; button.textContent = "检测中…";
        const hdr = Boolean(matchMedia("(video-dynamic-range: high)").matches || matchMedia("(dynamic-range: high)").matches);
        const video = document.createElement("video");
        const nativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
        const type = nativeHls ? "file" : "media-source";
        const base = { width: 3840, height: 2160, framerate: 24, bitrate: 20000000, colorGamut: "rec2020" };
        // Already in the player's order: Dolby Vision › HDR10 › HLG (no default set).
        const configs = [
          { label: "Dolby Vision 8.1", codec: "dvh1.08.06", transferFunction: "pq" },
          { label: "HDR10", codec: "hvc1.2.4.L153.B0", transferFunction: "pq", hdrMetadataType: "smpteSt2086" },
          { label: "HLG", codec: "hvc1.2.4.L153.B0", transferFunction: "hlg" },
        ];
        const rows = [["显示环境报告 HDR", hdr ? "是" : "否"], ["HDR 播放路径", nativeHls ? "原生 HLS（file）" : "MSE（media-source）"]];
        let pick = null;
        for (const config of configs) {
          const contentType = `video/mp4; codecs="${config.codec}"`;
          const playable = type === "file" ? video.canPlayType(contentType) !== "" : Boolean(window.MediaSource?.isTypeSupported?.(contentType));
          let verdict;
          if (!playable) verdict = "容器不支持该编码";
          else if (!navigator.mediaCapabilities?.decodingInfo) verdict = "浏览器没有 decodingInfo()";
          else {
            const { codec, label, ...videoConfig } = config;
            const started = performance.now();
            let timer;
            try {
              const info = await Promise.race([
                navigator.mediaCapabilities.decodingInfo({ type, video: { contentType, ...base, ...videoConfig } }),
                new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); }),
              ]);
              const ms = Math.round(performance.now() - started);
              verdict = !info ? "超时（>1.5 s）" : `${info.supported ? "支持" : "不支持"} · ${info.smooth ? "流畅" : "不流畅"} · ${ms} ms`;
              if (info?.supported && info.smooth && !pick) pick = config.label;
            } catch { verdict = "查询失败"; }
            clearTimeout(timer);
          }
          rows.push([`${config.label} · ${config.codec}`, verdict]);
        }
        rows.push(["结论", !hdr ? "显示环境未报告 HDR：本站不会查询 decodingInfo()，直接选择已验证 SDR（以上查询仅供参考）"
          : pick ? `自动选择 ${pick}（作品需提供该母版）` : "没有满足条件的候选 → 已验证 SDR"]);
        out.replaceChildren(...rows.flatMap(([term, value]) => {
          const dt = document.createElement("dt"), dd = document.createElement("dd");
          dt.textContent = term; dd.textContent = value; return [dt, dd];
        }));
        out.hidden = false;
        f.state.result = { hdr, pick: hdr ? pick : null };
        button.disabled = false; button.textContent = "再试一次";
        render(f);
        measure();
      },
    },

    // P5: native HLS vs Shaka + MSE, segments flowing to the platform decoder.
    p5: {
      init(f) {
        const native = document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";
        f.state.path = native ? "native" : "mse";
        f.el.querySelectorAll("[data-pick='path']").forEach(button => {
          button.setAttribute("aria-pressed", String(button.value === f.state.path));
          if (button.value === f.state.path) button.textContent += "（本机）";
        });
      },
      draw(g, w, h, p, f) {
        const pad = 18, narrow = w < 480, native = f.state.path === "native";
        const stages = native
          ? [["分段", "init.mp4 · m4s"], ["浏览器原生 HLS", "直接读取与缓冲"], ["平台解码器", "硬件加速由平台决定"], ["视频帧", ""]]
          : [["分段", "init.mp4 · m4s"], ["Shaka 缓冲", "获取并缓冲分段"], ["MSE SourceBuffer", "交给浏览器媒体管线"], ["平台解码器", "硬件加速由平台决定"], ["视频帧", ""]];
        const n = stages.length, vertical = narrow, gap = vertical ? 10 : 14;
        const bw = vertical ? w - pad * 2 - 40 : (w - pad * 2 - gap * (n - 1)) / n;
        const bh = vertical ? (h - pad * 2 - gap * (n - 1)) / n : 84;
        const by = vertical ? pad : 46;
        const box = i => vertical ? [pad + 40, pad + i * (bh + gap), bw, bh] : [pad + i * (bw + gap), by, bw, bh];
        if (!vertical) g.text(native ? "原生 HLS 路径" : "Shaka + MSE 路径", pad, 28, { font: SANS, size: 12, color: C.body });
        stages.forEach(([name, note], i) => {
          const [x, y, ww, hh] = box(i), last = i === n - 1;
          g.rect(x, y, ww, hh, { stroke: last ? C.ahead : C.sec, radius: 6 });
          g.text(name, x + 10, y + (vertical ? hh / 2 + (note ? -2 : 4) : 22), { font: SANS, size: 12, color: C.text, weight: 600 });
          if (note) g.text(note, x + 10, y + (vertical ? hh / 2 + 13 : 40), { font: SANS, size: 10.5, color: C.sec });
          if (i < n - 1) {
            const [nx, ny] = box(i + 1);
            if (vertical) g.arrow(x + 16, y + hh, x + 16, ny, { color: C.ahead, head: 4 }); else g.arrow(x + ww, y + hh / 2, nx, y + hh / 2, { color: C.ahead, head: 4 });
          }
        });
        // Decoded frames collect in the last box; the newest is the one in flight.
        const [fx, fy, fw, fh] = box(n - 1), frames = Math.floor(span(p, .35, 1) * 12);
        const fcols = 6, fs = Math.min((fw - 20 - (fcols - 1) * 4) / fcols, 14), frameTop = vertical ? fy + (fh - fs * .66) / 2 : fy + 52;
        for (let k = 0; k < frames && (vertical ? k < 6 : k < 12); k++) {
          const col = k % fcols, row = vertical ? 0 : Math.floor(k / fcols);
          const x = fx + (vertical ? fw - 10 - (fcols - col) * (fs + 4) : 10 + col * (fs + 4)), y = frameTop + row * (fs * .66 + 4);
          g.rect(x, y, fs, fs * .66, { fill: k === frames - 1 && p < 1 ? C.focus : C.sec, radius: 1.5, alpha: .9 });
        }
        if (!vertical) {
          const railY = by + bh + 18;
          g.seg(pad, railY, w - pad, railY, { color: C.line });
          g.text("数据流", pad, railY + 18, { font: SANS, size: 11, color: C.lab });
        } else g.seg(pad + 13, pad, pad + 13, h - pad, { color: C.line });
        const flow = p * (n - 1 + 1.6);
        for (let k = 0; k < 7; k++) {
          const pos = flow - k * .45;
          if (pos < 0 || pos > n - 1) continue;
          const i = Math.floor(pos), t = pos - i;
          const [x, y, ww, hh] = box(i), [nx, ny] = box(Math.min(n - 1, i + 1));
          if (vertical) g.rect(pad + 4, lerp(y + hh * .5, ny + hh * .5, t) - 5, 18, 10, { fill: C.sec, radius: 2, alpha: .9 });
          else g.rect(lerp(x + ww * .5, nx + ww * .5, t) - 9, by + bh + 14, 18, 9, { fill: C.sec, radius: 2, alpha: .9 });
        }
        if (!native && !vertical) {
          const [x, y, ww, hh] = box(1), level = span(p, .1, .7);
          g.rect(x + 10, y + hh - 18, ww - 20, 6, { stroke: C.line, radius: 2 });
          g.rect(x + 10, y + hh - 18, (ww - 20) * level, 6, { fill: C.sec, radius: 2 });
        }
        if (!narrow) {
          g.text("是否使用硬件加速由浏览器、系统与设备决定", pad, h - pad - 18, { font: SANS, size: 11, color: C.sec });
          g.text("通用 HEVC 解码能力不能直接证明支持 Dolby Vision", pad, h - pad, { font: SANS, size: 11, color: C.sec });
        }
        return native ? "原生 HLS：浏览器直接读取分段并调用平台解码器" : "Shaka 获取并缓冲分段，经 MSE 交给浏览器媒体管线";
      },
    },

    // C3: limited vs full range interpretation of 10-bit code values.
    c3: {
      draw(g, w, h, p, f) {
        const pad = 18, narrow = w < 480;
        const auto = f.state.case === "auto" || !f.state.case;
        const scrollCase = p < .4 ? "a" : p < .72 ? "b" : "c";
        const which = auto ? scrollCase : f.state.case;
        const morph = auto ? (which === "b" ? ease(span(p, .4, .55)) : which === "c" ? ease(span(p, .72, .87)) : 1) : 1;
        const fn = { a: cv => clamp((cv - 64) / 876), b: cv => cv / 1023, c: cv => clamp((cv - 64) / 876) };
        const sourceRange = which === "c" ? [0, 1023] : [64, 940];
        const px = pad + 34, pw = (narrow ? w - pad * 2 : w * .58) - 34, ptop = pad + 22, ph = h - pad * 2 - (narrow ? 96 : 70);
        const X = cv => px + pw * cv / 1023, Y = v => ptop + ph * (1 - v);
        g.rect(px, ptop, pw, ph, { stroke: C.line, radius: 2 });
        [64, 940].forEach(cv => { g.seg(X(cv), ptop, X(cv), ptop + ph, { color: C.ahead, dash: [.1, 4], width: 1.4 }); g.text(String(cv), X(cv), ptop - 5, { align: "center", color: C.sec }); });
        g.text("0", X(0), ptop + ph + 14, { align: "center", color: C.lab });
        g.text("1023", X(1023), ptop + ph + 14, { align: "center", color: C.lab });
        g.text("1", px - 6, ptop + 8, { align: "right", color: C.lab });
        g.text("0", px - 6, ptop + ph, { align: "right", color: C.lab });
        const curve = (map, range) => { const pts = []; for (let cv = range[0]; cv <= range[1]; cv += 8) pts.push([X(cv), Y(map(cv))]); pts.push([X(range[1]), Y(map(range[1]))]); return pts; };
        if (which !== "a") g.line(curve(fn.a, [64, 940]), { color: C.ahead, width: 1.2 });
        const prev = which === "c" ? fn.b : fn.a;
        const cur = cv => lerp(prev(cv), fn[which](cv), morph);
        g.line(curve(cur, sourceRange), { color: C.text, width: 2, alpha: span(p, 0, .2) });
        const steps = 11, sy = ptop + ph + 30, sw = (pw - (steps - 1) * 3) / steps;
        for (let i = 0; i < steps; i++) {
          const cv = lerp(sourceRange[0], sourceRange[1], i / (steps - 1)), level = Math.round(cur(cv) * 255);
          g.rect(px + i * (sw + 3), sy, sw, narrow ? 22 : 24, { fill: `rgb(${level},${level},${level})`, radius: 2 });
        }
        const black = cur(sourceRange[0]), white = cur(sourceRange[1]);
        const lx = narrow ? px : w * .58 + 24, ly = narrow ? sy + 44 : ptop + 14;
        const names = { a: "limited 内容 · 按 limited 解释", b: "limited 内容 · 误按 full 解释", c: "full 内容 · 误按 limited 解释" };
        g.text(names[which], lx, ly, { font: SANS, size: 12, color: C.text, weight: 600 });
        if (!narrow) {
          g.text(`黑位 ${(black * 100).toFixed(1)}%`, lx, ly + 26, { color: C.text });
          g.text(`白点 ${(white * 100).toFixed(1)}%`, lx, ly + 44, { color: C.text });
          if (which === "c") {
            g.text("0–64 压成纯黑", lx, ly + 70, { font: SANS, size: 11.5, color: C.text });
            g.text("940–1023 裁成纯白", lx, ly + 88, { font: SANS, size: 11.5, color: C.text });
          }
          if (which !== "a") {
            g.seg(lx, ly + 112, lx + 18, ly + 112, { color: C.ahead, width: 1.2 });
            g.text("正确解释", lx + 24, ly + 116, { font: SANS, size: 11, color: C.sec });
          }
          g.text("横轴：10-bit 码值", lx, h - pad - 18, { font: SANS, size: 11, color: C.sec });
          g.text("纵轴：解释后的信号", lx, h - pad, { font: SANS, size: 11, color: C.sec });
        }
        return { a: "正确：64 为黑，940 为白", b: `黑位抬高到 ${(black * 100).toFixed(1)}%，白点只到 ${(white * 100).toFixed(1)}%`, c: "两端码值被裁切：暗部与高光细节丢失" }[which];
      },
    },

    // C4: PQ (absolute) vs HLG (relative) with an adjustable display peak.
    c4: {
      draw(g, w, h, p, f) {
        const pad = 18, narrow = w < 480;
        const peak = f.state.peak || 1000, gamma = hlgGamma(peak);
        const px = pad + 42, pw = w - px - pad - (narrow ? 0 : 128), ptop = pad + 24, ph = h - pad * 2 - 48;
        const lo = -1, hi = 4;
        const X = e => px + pw * e, Y = L => ptop + ph * (1 - (Math.log10(Math.max(L, 1e-3)) - lo) / (hi - lo));
        for (let d = lo; d <= hi; d++) {
          const y = Y(10 ** d);
          g.seg(px, y, px + pw, y, { color: C.line, alpha: .6 });
          g.text(d < 0 ? "0.1" : String(10 ** d), px - 6, y + 4, { align: "right", color: C.lab });
        }
        [0, .25, .5, .75, 1].forEach(e => g.text(e.toFixed(2), X(e), ptop + ph + 16, { align: "center", color: C.lab }));
        g.text("信号", px + pw, ptop + ph + 30, { align: "right", font: SANS, size: 11, color: C.sec });
        g.text("cd/m²", px - 6, pad + 6, { align: "right", color: C.sec });
        const py = Y(peak);
        g.seg(px, py, px + pw, py, { color: C.body, alpha: .7 });
        g.text(`屏幕峰值 ${peak}`, px + 6, py - 6, { font: SANS, size: 11, color: C.text });
        const pqDraw = span(p, 0, .5), hlgDraw = span(p, .45, .95);
        const pqPts = [], over = [];
        for (let i = 0; i <= 200 * pqDraw; i++) {
          const e = i / 200, L = pqNits(e);
          if (L < .1) continue;
          (L <= peak ? pqPts : over).push([X(e), Y(L)]);
        }
        if (over.length && pqPts.length) over.unshift(pqPts[pqPts.length - 1]);
        g.line(pqPts, { color: C.text, width: 2.2 });
        g.line(over, { color: C.ahead, width: 1.4 });
        const hlgPts = [];
        for (let i = 0; i <= 200 * hlgDraw; i++) {
          const e = i / 200, L = peak * Math.pow(hlgScene(e), gamma);
          if (L >= .1) hlgPts.push([X(e), Y(L)]);
        }
        g.line(hlgPts, { color: C.sec, width: 1.8 });
        [.25, .5, .75, 1].forEach(e => { if (e <= hlgDraw + 1e-9) g.dot(X(e), Y(peak * Math.pow(hlgScene(e), gamma)), 3, { fill: C.bg, stroke: C.sec, width: 1.5 }); });
        const lx = narrow ? X(.5) : px + pw + 16, ly = narrow ? Y(.8) : ptop + 16;
        g.seg(lx, ly - 4, lx + 18, ly - 4, { color: C.text, width: 2.2 });
        g.text("PQ · 绝对亮度", lx + 24, ly, { font: SANS, size: 11.5, color: C.body });
        g.seg(lx, ly + 16, lx + 18, ly + 16, { color: C.sec, width: 1.8 });
        g.dot(lx + 9, ly + 16, 3, { fill: C.bg, stroke: C.sec, width: 1.5 });
        g.text("HLG · 相对亮度", lx + 24, ly + 20, { font: SANS, size: 11.5, color: C.body });
        if (!narrow) {
          g.text(`HLG 系统伽马 ${gamma.toFixed(2)}`, lx, ly + 52, { color: C.text });
          g.text("PQ 0.508 → 100", lx, ly + 78, { color: C.sec });
          g.text("PQ 0.752 → 1000", lx, ly + 96, { color: C.sec });
          g.seg(lx, ly + 118, lx + 18, ly + 118, { color: C.ahead, width: 1.4 });
          g.text("超出屏幕能力", lx + 24, ly + 122, { font: SANS, size: 11, color: C.sec });
        }
        if (p < .45) return "PQ：码值对应固定的目标亮度，与屏幕无关";
        return `HLG：随屏幕峰值缩放 · 系统伽马 ${gamma.toFixed(2)}`;
      },
    },

    // C5: BT.2020 boundary colours mapped into the display gamut (illustrative).
    c5: {
      draw(g, w, h, p, f) {
        const pad = 18, narrow = w < 480;
        const display = GAMUT[f.state.display || "p3"];
        const frame = xyFrame(pad + 22, pad, (narrow ? w - pad * 2 : w * .62) - 22, h - pad * 2 - 14);
        drawXyGrid(g, frame);
        drawLocus(g, frame, 1);
        triangle(g, frame, GAMUT.rec2020, 1, { color: C.sec, width: 1.2 });
        triangle(g, frame, display, ease(span(p, .1, .3)), { color: C.text, width: 2 });
        const tri = display.rgb;
        const toward = point => {
          let best = 1;
          for (let i = 0; i < 3; i++) {
            const a = tri[i], b = tri[(i + 1) % 3];
            const dx = point[0] - D65[0], dy = point[1] - D65[1], ex = b[0] - a[0], ey = b[1] - a[1];
            const den = dx * ey - dy * ex;
            if (Math.abs(den) < 1e-9) continue;
            const s = ((a[0] - D65[0]) * ey - (a[1] - D65[1]) * ex) / den;
            const u = ((a[0] - D65[0]) * dy - (a[1] - D65[1]) * dx) / den;
            if (s > 0 && u >= 0 && u <= 1) best = Math.min(best, s);
          }
          return [D65[0] + (point[0] - D65[0]) * best, D65[1] + (point[1] - D65[1]) * best];
        };
        const src = GAMUT.rec2020.rgb, samples = [];
        for (let i = 0; i < 3; i++) for (const t of [0, .35, .7]) samples.push([lerp(src[i][0], src[(i + 1) % 3][0], t), lerp(src[i][1], src[(i + 1) % 3][1], t)]);
        const t = ease(span(p, .35, .85)), moving = t > 0 && t < 1;
        samples.forEach(s => {
          const m = toward(s), [x0, y0] = frame.map(s), [x1, y1] = frame.map(m);
          const here = [lerp(s[0], m[0], t), lerp(s[1], m[1], t)];
          if (t > 0) g.seg(x0, y0, lerp(x0, x1, t), lerp(y0, y1, t), { color: C.ahead, width: 1 });
          g.dot(x0, y0, 3.6, { stroke: cssRgb(xyColor(s, MARK_MIN_Y)), width: 1.6 });
          if (t > 0) g.dot(lerp(x0, x1, t), lerp(y0, y1, t), 4, { fill: cssRgb(xyColor(here, MARK_MIN_Y)), stroke: moving ? C.focus : C.bg, width: 1.4 });
        });
        g.dot(...frame.map(D65), 3, { fill: C.text });
        const lx = narrow ? frame.map([.43, 0])[0] : w * .62 + 26, ly = narrow ? frame.map([0, .86])[1] : pad + 22;
        [["BT.2020 信号", C.sec, 1.2, 1], [`屏幕 ${display.label}`, C.text, 2, span(p, .1, .3)]].forEach(([label, color, width, a], i) => {
          g.seg(lx, ly + i * 20 - 4, lx + 20, ly + i * 20 - 4, { color, width, alpha: a });
          g.text(label, lx + 28, ly + i * 20, { font: SANS, size: 11.5, color: C.body, alpha: a });
        });
        if (!narrow) {
          g.text("超出屏幕色域的样本色", lx, ly + 56, { font: SANS, size: 11.5, color: C.sec });
          g.text("沿白点方向收进屏幕色域", lx, ly + 74, { font: SANS, size: 11.5, color: C.sec });
          g.text("实际映射算法因平台而异", lx, ly + 100, { font: SANS, size: 11.5, color: C.sec });
        }
        return p < .35 ? `源色域 BT.2020，屏幕 ${display.label}` : t < 1 ? "超出部分向白点方向压缩" : `全部样本落进 ${display.label}`;
      },
    },

    // P6: the fallback order inside one playback session.
    p6: {
      draw(g, w, h, p, f) {
        const pad = 18, narrow = w < 480, scenario = f.state.scenario || "hdr";
        const lanes = ["Dolby Vision", "关联 SDR", "其他已验证 SDR"];
        const lx = pad + (narrow ? 86 : 112), rx = w - pad - 6, top = pad + 6, laneH = Math.min(50, (h - pad * 2 - 88) / 3);
        const T = s => lx + (rx - lx) * s / 90, fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
        const laneY = i => top + i * laneH + laneH / 2;
        lanes.forEach((name, i) => {
          const missing = scenario === "none" && i > 0;
          g.text(name, pad, laneY(i) + 4, { font: SANS, size: 11.5, color: missing ? C.lab : C.body });
          g.seg(lx, laneY(i), rx, laneY(i), { color: missing ? C.line : C.ahead });
          if (missing) g.text("无", lx + 8, laneY(i) - 6, { font: SANS, size: 11, color: C.lab });
        });
        [0, 30, 60, 90].forEach(s => g.text(fmt(s), T(s), top + 3 * laneH + 12, { align: "center", color: C.lab }));
        const failAt = 42, sdrFailAt = 65, now = 90 * span(p, 0, .95);
        g.seg(T(0), laneY(0), T(Math.min(now, failAt)), laneY(0), { color: C.text, width: 3 });
        let status = `HDR 播放中 ${fmt(now)}`, playhead = [T(Math.min(now, failAt)), laneY(0)];
        let position = now, intent = "播放中", master = "Dolby Vision";
        if (now >= failAt) {
          g.cross(T(failAt) - 5, laneY(0) - 5, 10, C.text);
          if (scenario === "none") {
            status = "没有可用 SDR：自动选源无法继续"; playhead = null; position = failAt; intent = "已停止"; master = "—";
            const bx = T(failAt) + 14;
            g.rect(bx, laneY(1) - 14, Math.min(rx - bx, 240), 48, { stroke: C.text, radius: 6 });
            g.text("可手动尝试已有母版", bx + 10, laneY(1) + 4, { font: SANS, size: 11.5, color: C.text });
            g.text("或由作者补充 SDR", bx + 10, laneY(1) + 22, { font: SANS, size: 11.5, color: C.sec });
          } else {
            g.seg(T(failAt), laneY(0) + 6, T(failAt), laneY(1), { color: C.text, dash: [.1, 4], width: 1.6 });
            if (!narrow) g.text(`保留位置 ${fmt(failAt)} · 保持播放`, T(failAt) + 8, laneY(0) + laneH / 2 + 4, { font: SANS, size: 11, color: C.text });
            const end = scenario === "both" ? Math.min(now, sdrFailAt) : now;
            g.seg(T(failAt), laneY(1), T(end), laneY(1), { color: C.text, width: 3 });
            playhead = [T(end), laneY(1)]; position = end; master = "关联 SDR";
            status = `已切换关联 SDR · ${fmt(end)}`;
            if (scenario === "both" && now >= sdrFailAt) {
              g.cross(T(sdrFailAt) - 5, laneY(1) - 5, 10, C.text);
              playhead = null; intent = "等待重试"; master = "—";
              const bx = T(sdrFailAt) + 12;
              g.rect(bx, laneY(2) - 14, Math.min(rx - bx, 170), 28, { stroke: C.text, radius: 6 });
              g.text("显示错误与重试", bx + 10, laneY(2) + 4, { font: SANS, size: 11.5, color: C.text });
              g.line([[T(sdrFailAt) - 10, laneY(1) - 8], [T(sdrFailAt) - 10, laneY(0) + 10]], { color: C.ahead, dash: [.1, 4], width: 1.6 });
              g.cross(T(sdrFailAt) - 15, (laneY(0) + laneY(1)) / 2 - 5, 10, C.ahead);
              status = "SDR 也失败：停在错误与重试，不在 HDR / SDR 间循环";
            }
          }
        }
        if (playhead) { g.dot(...playhead, 6, { fill: C.focus }); g.dot(...playhead, 6, { stroke: C.bg, width: 2 }); }
        // Player state: what the switch preserves.
        const sy = h - pad - 4, cols = [["位置", fmt(position)], ["播放意图", intent], ["当前母版", master]];
        g.seg(pad, sy - 34, w - pad, sy - 34, { color: C.line });
        cols.forEach(([label, value], i) => {
          const x = pad + i * ((w - pad * 2) / 3);
          g.text(label, x, sy - 16, { font: SANS, size: 11, color: C.sec });
          g.text(value, x, sy, { color: C.text, size: 12, weight: 600 });
        });
        return status;
      },
    },
  };

  // ---------- figure lifecycle ----------
  const items = figures.map(el => {
    const canvas = el.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const item = { el, canvas, ctx, paint: painter(ctx), plate: el.querySelector(".fig-plate"), stateEl: el.querySelector(".fig-state"),
      def: DEFS[el.dataset.fig], state: {}, p: -1, w: 0, h: 0, top: 0, visible: false };
    el.querySelectorAll("[data-toggle]").forEach(button => {
      item.state[button.dataset.toggle] = button.getAttribute("aria-pressed") === "true";
      button.addEventListener("click", () => {
        const on = button.getAttribute("aria-pressed") !== "true";
        button.setAttribute("aria-pressed", String(on));
        item.state[button.dataset.toggle] = on;
        render(item);
      });
    });
    el.querySelectorAll("[data-pick]").forEach(button => {
      if (button.getAttribute("aria-pressed") === "true") item.state[button.dataset.pick] = button.value;
      button.addEventListener("click", () => {
        el.querySelectorAll(`[data-pick='${button.dataset.pick}']`).forEach(other => other.setAttribute("aria-pressed", String(other === button)));
        item.state[button.dataset.pick] = button.value;
        render(item);
      });
    });
    el.querySelectorAll("[data-input]").forEach(input => {
      const output = el.querySelector(`output[for='${input.id}']`);
      const read = () => { item.state[input.dataset.input] = Number(input.value); if (output) output.textContent = `${input.value} cd/m²`; };
      read();
      input.addEventListener("input", () => { read(); render(item); });
    });
    el.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => item.def.action?.(button.dataset.action, item)));
    item.def.init?.(item);
    el.dataset.ready = "";
    return item;
  });

  function render(item) {
    if (!item.w || !item.def) return;
    item.ctx.clearRect(0, 0, item.w, item.h);
    const status = item.def.draw(item.paint, item.w, item.h, Math.max(0, item.p), item);
    if (status && status !== item.status) { item.status = status; item.stateEl.textContent = status; }
  }

  // A figure plays only while the reader can see all of it: it starts once the
  // whole plate is inside the readable window and finishes as its top is about
  // to leave. The window sits below the sticky header, or below the pinned route
  // strip on phones and short windows.
  const stripLayout = matchMedia("(max-width: 860px), (max-height: 560px)");
  const MARGIN = 24, MIN_RANGE = 200;
  let windowTop = 0, windowBottom = 0, frame = 0;
  function progressOf(item) {
    if (reduced.matches) return 1;
    const top = item.top - scrollY;
    const start = windowBottom - MARGIN - item.h;
    const end = Math.min(start - MIN_RANGE, windowTop + MARGIN);
    return clamp((start - top) / (start - end));
  }
  function measure() {
    readTokens();
    const journey = document.querySelector(".journey");
    const header = document.querySelector(".site-header")?.getBoundingClientRect().height || 60;
    const readingLine = parseFloat(journey?.style.getPropertyValue("--reading-offset")) || header;
    windowTop = stripLayout.matches ? Math.max(header, readingLine - 20) : header;
    windowBottom = innerHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    items.forEach(item => {
      const rect = item.plate.getBoundingClientRect();
      item.top = rect.top + scrollY;
      if (rect.width !== item.w || rect.height !== item.h) {
        item.w = rect.width; item.h = rect.height;
        item.canvas.width = Math.round(rect.width * dpr); item.canvas.height = Math.round(rect.height * dpr);
        item.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        item.p = -1;
      }
    });
    update();
  }
  function update() {
    frame = 0;
    items.forEach(item => {
      if (!item.visible) return;
      const p = progressOf(item);
      if (Math.abs(p - item.p) < .0008) return;
      item.p = p;
      render(item);
    });
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    const item = items.find(candidate => candidate.plate === entry.target);
    item.visible = entry.isIntersecting;
    if (item.visible) { item.p = -1; schedule(); }
  }), { rootMargin: "120px 0px" });
  items.forEach(item => observer.observe(item.plate));
  const resize = new ResizeObserver(() => requestAnimationFrame(measure));
  resize.observe(document.querySelector(".stops") || document.body);
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", measure);
  stripLayout.addEventListener("change", measure);
  reduced.addEventListener("change", () => { items.forEach(item => { item.p = -1; }); update(); });
  document.fonts?.ready.then(measure);
  addEventListener("load", () => { items.forEach(item => { item.p = -1; }); measure(); }, { once: true });
  requestAnimationFrame(measure);
})();
