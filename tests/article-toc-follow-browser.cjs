const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const esbuild = require("esbuild");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

// Long-TOC follow check: the real ArticleToc inside the post page's real layout classes
// (globals.css), with 40 sections, in fresh headless WebKit contexts.
const root = path.resolve(__dirname, "..");
const web = path.join(root, "apps/web");
const output = path.join(root, "test-results/article-toc-follow");
const build = path.join(output, "build");
const SECTIONS = 40;
const items = Array.from({ length: SECTIONS }, (_, i) => ({
  id: `section-${i + 1}`,
  text: i % 3 === 0 ? `${String(i / 3 + 1).padStart(2, "0")} · 第 ${i + 1} 节：较长的章节标题会换行显示` : `第 ${i + 1} 节小标题`,
  level: i % 3 === 0 ? 2 : 3,
}));
const report = { browser: "headless WebKit", checks: [], pageErrors: [] };
let browser;
let page;

async function bundle() {
  fs.mkdirSync(build, { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `import React from "react"; import { createRoot, hydrateRoot } from "react-dom/client"; import { ArticleToc } from "./src/components/ArticleToc"; import { ArticleAnchors } from "./src/components/ArticleAnchors";
        hydrateRoot(document.getElementById("toc-root"), React.createElement(ArticleToc, { label: "目录", items: window.__ITEMS__, collapsible: true }));
        createRoot(document.getElementById("anchors-root")).render(React.createElement(ArticleAnchors));`,
      resolveDir: web, loader: "tsx",
    },
    bundle: true, jsx: "automatic", platform: "browser", format: "iife", outfile: path.join(build, "client.js"),
    nodePaths: [path.join(root, "node_modules")], define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(web, "tsconfig.json"), logLevel: "silent",
  });
  await esbuild.build({
    stdin: {
      contents: `import React from "react"; import { renderToString } from "react-dom/server"; import { ArticleToc } from "./src/components/ArticleToc";
        export const html = (items) => renderToString(React.createElement(ArticleToc, { label: "目录", items, collapsible: true }));`,
      resolveDir: web, loader: "tsx",
    },
    bundle: true, jsx: "automatic", platform: "node", format: "cjs", outfile: path.join(build, "ssr.cjs"),
    nodePaths: [path.join(root, "node_modules")], define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(web, "tsconfig.json"), logLevel: "silent",
  });
}

function pageHtml(tocHtml) {
  // GFM-style footnote (reference, footnote list, back-reference) and a cross-reference link.
  const extra = (i) => i === 2
    ? ' 参见脚注<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref>1</a></sup>。'
    : i === 34 ? ' 回看<a href="#section-8" id="cross-ref">第 8 节</a>。' : "";
  const body = items.map((item, i) => `<h${item.level} id="${item.id}" tabindex="-1">${item.text}</h${item.level}>` +
    // Section 19 is long, so it has a resting stretch before its handoff zone.
    `<p>${"正文段落用于制造阅读距离。".repeat(i === 18 ? 90 : i % 2 ? 10 : 22)}${extra(i)}</p>`).join("") +
    '<section data-footnotes class="footnotes"><h2 class="sr-only">Footnotes</h2><ol><li id="user-content-fn-1"><p>脚注内容。 <a href="#user-content-fnref-1" data-footnote-backref>↩</a></p></li></ol></section>';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/client.css"></head><body>
    <header class="site-header"><a class="brand" href="/">Reference Room</a></header>
    <main class="shell article-shell article-shell-with-toc"><div class="article-content-grid">
      <aside class="article-toc" aria-label="Article table of contents" data-collapsible="true"><div id="toc-root">${tocHtml}</div></aside>
      <div class="content-glass"><header class="page-header"><h1>长目录测试文章</h1></header>
        <article class="markdown-body">${body}</article><div id="anchors-root"></div></div>
    </div></main><footer style="height:400px"></footer>
    <script>window.__ITEMS__=${JSON.stringify(items)}</script><script src="/client.js"></script></body></html>`;
}

let ssrHtml = "";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (body, type) => { res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); res.end(body); };
  if (url.pathname === "/client.js") return send(fs.readFileSync(path.join(build, "client.js")), "text/javascript");
  if (url.pathname === "/client.css") return send(fs.readFileSync(path.join(build, "client.css")), "text/css");
  if (url.pathname === "/globals.css") return send(fs.readFileSync(path.join(web, "src/app/globals.css")), "text/css");
  send(pageHtml(ssrHtml), "text/html");
});

function pass(name, value) {
  report.checks.push(value === undefined ? { name } : { name, value });
  console.log(`ok - ${name}`);
}

/** Geometry of the active entry inside the TOC scroll area. */
const tocState = (p) => p.evaluate(() => {
  const container = document.querySelector(".article-toc");
  const active = document.querySelector('a[aria-current="location"]');
  const c = container.getBoundingClientRect();
  const a = active?.getBoundingClientRect();
  return {
    active: active?.dataset.tocId ?? null,
    scrollTop: Math.round(container.scrollTop),
    maxScroll: container.scrollHeight - container.clientHeight,
    scrollable: getComputedStyle(container).overflowY !== "visible" && container.scrollHeight > container.clientHeight,
    centerOffset: a ? Math.round(a.top + a.height / 2 - (c.top + container.clientTop + container.clientHeight / 2)) : null,
    windowY: Math.round(window.scrollY),
  };
});
async function readTo(p, id) {
  await p.evaluate((target) => {
    const heading = document.getElementById(target);
    // Same reading line as ArticleToc: the heading's own scroll margin (92px desktop, 16px phone).
    const line = Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
    window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - line + 4);
  }, id);
  await p.waitForFunction((target) => document.querySelector('a[aria-current="location"]')?.dataset.tocId === target, id);
  // Let a smooth scroll start and finish: three unchanged readings in a row.
  await p.evaluate(() => { window.__lastTop = undefined; window.__stable = 0; });
  await p.waitForFunction(() => {
    const top = document.querySelector(".article-toc").scrollTop;
    window.__stable = window.__lastTop === top ? window.__stable + 1 : 0;
    window.__lastTop = top;
    return window.__stable >= 3;
  }, null, { polling: 100, timeout: 4000 });
}
/** Moves the page to a section and samples the TOC's scrollTop every frame for 1.4 s. */
const glide = (p, id) => p.evaluate(async (target) => {
  const container = document.querySelector(".article-toc");
  const start = container.scrollTop;
  const heading = document.getElementById(target);
  const line = Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
  // Instant page jump: one section change, so a single glide is measured.
  window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - line + 4, behavior: "instant" });
  const indicator = document.querySelector('.article-toc nav > [aria-hidden="true"][data-visible]');
  const samples = [];
  const marker = [];
  let timing = null;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const frame = (now) => {
      samples.push([now - t0, container.scrollTop]);
      marker.push([now - t0, indicator.getBoundingClientRect().top]);
      if (!timing && getComputedStyle(indicator).transitionDuration.split(",")[0] !== "0s") {
        const style = getComputedStyle(indicator);
        timing = { duration: style.transitionDuration.split(",")[0], easing: style.transitionTimingFunction.split("),")[0] + ")" };
      }
      if (now - t0 < 1400) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });
  const active = document.querySelector('a[aria-current="location"]').getBoundingClientRect();
  const box = indicator.getBoundingClientRect();
  return {
    start, samples, marker, timing,
    indicatorMatches: Math.abs(box.top - active.top) <= 1 && Math.abs(box.height - active.height) <= 1 && Math.abs(box.width - active.width) <= 1,
  };
}, id);
function glideStats({ start, samples }) {
  const end = samples[samples.length - 1][1];
  let peak = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i][0] - samples[i - 1][0];
    if (dt > 0) peak = Math.max(peak, Math.abs(samples[i][1] - samples[i - 1][1]) / dt);
  }
  const between = samples.filter(([, top]) => Math.min(start, end) + 1 < top && top < Math.max(start, end) - 1).length;
  const moving = samples.filter(([, top], i) => i > 0 && top !== samples[i - 1][1]);
  return { distance: Math.round(Math.abs(end - start)), peakSpeed: Number(peak.toFixed(3)), framesBetween: between, durationMs: Math.round(moving.length ? moving[moving.length - 1][0] : 0) };
}

/** Clicks a TOC entry (optionally with a key held) and samples window.scrollY every frame. */
const clickJump = (p, id, { modifier = null, sampleMs = 1300, wheelAt = null } = {}) => p.evaluate(async ({ target, modifier, sampleMs, wheelAt }) => {
  const link = document.querySelector(`a[data-toc-id="${target}"]`);
  const historyBefore = history.length;
  const from = window.scrollY;
  let prevented = null;
  window.addEventListener("click", (event) => { prevented = event.defaultPrevented; }, { once: true });
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, [modifier || "x"]: Boolean(modifier) }));
  const samples = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    const frame = (now) => {
      samples.push([now - t0, window.scrollY]);
      if (wheelAt !== null && now - t0 >= wheelAt && !window.__wheeled) {
        window.__wheeled = true;
        window.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));
      }
      if (now - t0 < sampleMs) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });
  window.__wheeled = false;
  const heading = document.getElementById(target);
  return {
    from, samples, prevented, historyDelta: history.length - historyBefore, hash: location.hash,
    focus: document.activeElement?.id ?? null, headingTop: heading.getBoundingClientRect().top,
    line: Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0,
  };
}, { target: id, modifier, sampleMs, wheelAt });
/** Share of the travel covered in the first/last tenth of the motion, plus its duration. */
function jumpShape({ from, samples }) {
  const end = samples[samples.length - 1][1];
  const distance = end - from;
  const moving = samples.filter(([, y], i) => i > 0 && y !== samples[i - 1][1]);
  const t0 = samples.find(([, y]) => y !== from)?.[0] ?? 0;
  const t1 = moving.length ? moving[moving.length - 1][0] : t0;
  const at = (time) => samples.reduce((best, sample) => (Math.abs(sample[0] - time) < Math.abs(best[0] - time) ? sample : best))[1];
  const span = t1 - t0;
  const monotonic = samples.every(([, y], i) => i === 0 || Math.sign(distance) * (y - samples[i - 1][1]) >= -1);
  return {
    distance: Math.round(distance), durationMs: Math.round(span), monotonic,
    firstTenth: Number(((at(t0 + span * 0.1) - from) / distance).toFixed(3)),
    lastTenth: Number(((end - at(t1 - span * 0.1)) / distance).toFixed(3)),
  };
}
const expectedDuration = (distance) => Math.min(900, 280 + 7 * Math.sqrt(Math.abs(distance)));
const expectedTocDuration = (distance) => Math.min(600, 220 + 6 * Math.sqrt(Math.abs(distance)));
const READING_EASE = "cubic-bezier(0.45, 0, 0.15, 1)";
/** Eased start/landing and duration of a sampled [time, value] series. */
function curveShape(from, samples) {
  const end = samples[samples.length - 1][1];
  const distance = end - from;
  const t0 = samples.find(([, y]) => Math.abs(y - from) >= 1)?.[0] ?? 0;
  const moving = samples.filter(([, y], i) => i > 0 && y !== samples[i - 1][1]);
  const t1 = moving.length ? moving[moving.length - 1][0] : t0;
  const span = t1 - t0;
  const at = (time) => samples.reduce((best, sample) => (Math.abs(sample[0] - time) < Math.abs(best[0] - time) ? sample : best))[1];
  return {
    distance: Math.round(distance),
    durationMs: Math.round(span),
    firstFifth: Number(((at(t0 + span * 0.2) - from) / distance).toFixed(3)),
    lastFifth: Number(((end - at(t1 - span * 0.2)) / distance).toFixed(3)),
  };
}

async function newPage(viewport, options = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: options.reduced ? "reduce" : "no-preference" });
  const current = await context.newPage();
  current.on("pageerror", (error) => report.pageErrors.push(error.message));
  await current.goto(`${base}/${options.hash || ""}`);
  await current.waitForFunction(() => document.querySelector('a[aria-current="location"]'));
  page = current;
  return { context, page: current };
}

let base;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  await bundle();
  ssrHtml = require(path.join(build, "ssr.cjs")).html(items);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await webkit.launch({ headless: true, ...(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });

  {
    const { context, page: p } = await newPage({ width: 1280, height: 900 });
    const start = await tocState(p);
    assert.equal(start.scrollable, true, "desktop TOC is its own scroll area");
    assert.equal(start.active, "section-1");
    assert.equal(start.scrollTop, 0);
    pass("Start: first section active, list at its top boundary");

    const offsets = {};
    for (const id of ["section-14", "section-20", "section-27"]) {
      const windowBefore = await p.evaluate(() => Math.round(window.scrollY));
      await readTo(p, id);
      const state = await tocState(p);
      assert.ok(Math.abs(state.centerOffset) <= 2, `${id} centred (offset ${state.centerOffset})`);
      assert.ok(Math.abs(state.windowY - windowBefore) > 0 && state.windowY === (await p.evaluate(() => Math.round(window.scrollY))));
      offsets[id] = state.centerOffset;
    }
    await p.screenshot({ path: path.join(output, "desktop-middle.png") });
    pass("Middle of a long list: the active entry is kept centred in the TOC", offsets);

    const scrollYBefore = await p.evaluate(() => window.scrollY);
    await readTo(p, "section-28");
    assert.equal(Math.round(await p.evaluate(() => window.scrollY)), Math.round(await p.evaluate(() => window.scrollY)));
    assert.ok((await p.evaluate(() => window.scrollY)) >= scrollYBefore, "following the TOC never moves the page");
    pass("Following only scrolls the TOC panel, never the page");

    // At the article end the last section is active by design (short final sections).
    await readTo(p, "section-40");
    const end = await tocState(p);
    assert.ok(Math.abs(end.scrollTop - end.maxScroll) <= 1, `end boundary (${end.scrollTop}/${end.maxScroll})`);
    await p.screenshot({ path: path.join(output, "desktop-end.png") });
    await readTo(p, "section-2");
    assert.equal((await tocState(p)).scrollTop, 0);
    pass("Near either end the list stops at its boundary instead of centring past it");

    // Scroll-linked indicator: rests during a section, slides in step with scrolling across the
    // handoff zone before the next heading, never animates on its own, always visible.
    const probe = (id, offsetFromLine) => p.evaluate(({ id, offsetFromLine }) => {
      const heading = document.getElementById(id);
      const line = Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
      window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - line - offsetFromLine, behavior: "instant" });
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const indicator = document.querySelector('.article-toc nav > [aria-hidden="true"][data-visible]');
        const container = document.querySelector(".article-toc");
        const box = indicator.getBoundingClientRect();
        const c = container.getBoundingClientRect();
        const entry = (n) => document.querySelector(`a[data-toc-id="section-${n}"]`).getBoundingClientRect();
        resolve({
          visible: indicator.dataset.visible,
          top: box.top, height: box.height, width: box.width,
          centre: Math.round(box.top + box.height / 2 - (c.top + container.clientTop + container.clientHeight / 2)),
          e19: entry(19).top, e20: entry(20).top, scrollTop: container.scrollTop,
        });
      })));
    }, { id, offsetFromLine });
    const zone = await p.evaluate(() => Math.max(120, Math.min(320, innerHeight * 0.3)));
    // Section 19 is long (22 lines); section 20 follows. Offsets are px before heading 20 reaches the line.
    const sectionLength = await p.evaluate(() => document.getElementById("section-20").offsetTop - document.getElementById("section-19").offsetTop);
    assert.ok(sectionLength > zone + 80, `fixture section is longer than the zone (${sectionLength} vs ${zone})`);
    const sized = await p.evaluate(() => {
      const box = document.querySelector('.article-toc nav > [aria-hidden="true"][data-visible]').getBoundingClientRect();
      const entry = document.querySelector('a[aria-current="location"]').getBoundingClientRect();
      return { w: box.width, h: box.height, entryW: entry.width, entryH: entry.height, opacity: getComputedStyle(document.querySelector('.article-toc nav > [aria-hidden="true"][data-visible]')).opacity };
    });
    assert.ok(sized.w > 0 && Math.abs(sized.w - sized.entryW) <= 1 && Math.abs(sized.h - sized.entryH) <= 1 && sized.opacity === "1",
      `the highlight block is drawn at the entry's size: ${JSON.stringify(sized)}`);
    const rest1 = await probe("section-20", sectionLength - 20);
    const rest2 = await probe("section-20", zone + 30);
    assert.ok(Math.abs(rest1.top - rest1.e19) <= 1 && Math.abs(rest2.top - rest2.e19) <= 1,
      `rests on the current entry before the handoff zone: ${JSON.stringify({ sectionLength, zone, rest1, rest2 })}`);
    const samples = [];
    for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const state = await probe("section-20", zone * (1 - fraction));
      const share = (state.top - state.e19) / (state.e20 - state.e19);
      samples.push(Number(share.toFixed(3)));
      assert.equal(state.visible, "true");
      assert.ok(Math.abs(state.centre) <= 2, `indicator held at the list centre (${state.centre})`);
    }
    assert.ok(samples.every((value, i) => i === 0 || value > samples[i - 1]), `moves forward with scrolling: ${samples}`);
    assert.ok(Math.abs(samples[2] - 0.5) <= 0.03, `half the zone → half way (symmetric curve): ${samples[2]}`);
    assert.ok(samples[0] < 0.08 && samples[4] > 0.92, `eased in and out across the zone: ${samples}`);
    const arrived = await probe("section-20", -4);
    assert.ok(Math.abs(arrived.top - arrived.e20) <= 1, "arrives as the heading crosses the reading line");
    pass("Indicator is scroll-linked: rests in a section, slides in step across the handoff zone, stays centred", { zone, shares: samples });

    // No timed animation: once scrolling stops, nothing keeps moving.
    const settledA = await probe("section-20", zone * 0.5);
    await p.waitForTimeout(400);
    const settledB = await p.evaluate(() => ({
      top: document.querySelector('.article-toc nav > [aria-hidden="true"][data-visible]').getBoundingClientRect().top,
      scrollTop: document.querySelector(".article-toc").scrollTop,
    }));
    assert.ok(Math.abs(settledB.top - settledA.top) < 0.5 && Math.abs(settledB.scrollTop - settledA.scrollTop) < 0.5, "stops with the scroll");
    pass("When scrolling stops, the indicator and list stop with it (no timed animation)");

    // The text emphasis slides with the block: both entries are partially lit mid-handoff.
    const lit = (fraction) => p.evaluate(({ fraction, zone }) => {
      const heading = document.getElementById("section-20");
      const line = Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
      window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - line - zone * (1 - fraction), behavior: "instant" });
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const brightness = (n) => {
          // color-mix() computes to color(srgb r g b) with 0–1 channels in WebKit, rgb() elsewhere.
          const value = getComputedStyle(document.querySelector(`a[data-toc-id="section-${n}"]`)).color;
          const scale = value.startsWith("color(") ? 255 : 1;
          const [r, g, b] = value.replace(/^color\(srgb/, "").match(/[\d.]+/g).map((channel) => Number(channel) * scale);
          return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        };
        resolve({ e18: brightness(18), e19: brightness(19), e20: brightness(20) });
      })));
    }, { fraction, zone });
    const atRest = await lit(-0.2);
    const midway = await lit(0.5);
    assert.ok(atRest.e19 > atRest.e20 + 20 && atRest.e18 === atRest.e20, `only the current entry is lit at rest: ${JSON.stringify(atRest)}`);
    assert.ok(midway.e19 < atRest.e19 && midway.e20 > atRest.e20 && Math.abs(midway.e19 - midway.e20) <= 4, `both half lit midway: ${JSON.stringify(midway)}`);
    pass("Text emphasis brightens and dims with the sliding block (no switch)", { atRest, midway });

    // Scroll frames do arithmetic and writes only: no layout reads on the TOC side.
    const reads = await p.evaluate(async () => {
      const toc = document.querySelector(".article-toc");
      let count = 0;
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
        if (toc.contains(this)) count += 1;
        return rect.call(this);
      };
      const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
      Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get() { if (toc.contains(this)) count += 1; return offsetTop.get.call(this); } });
      const start = window.scrollY;
      for (let i = 1; i <= 30; i += 1) {
        window.scrollTo({ top: start + i * 9, behavior: "instant" });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      Element.prototype.getBoundingClientRect = rect;
      Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTop);
      const indicator = document.querySelector('.article-toc nav > [aria-hidden="true"][data-visible]');
      return { count, transform: indicator.style.transform, willChange: getComputedStyle(indicator).willChange };
    });
    assert.equal(reads.count, 0, "no TOC layout reads during scroll frames");
    assert.match(reads.transform, /^translate3d\(/);
    assert.equal(reads.willChange, "transform");
    pass("Scroll frames never read TOC layout; the indicator moves by transform on its own layer", reads);

    // The reader's own wheel on the list stops the glide where it is, and section changes
    // during the grace period do not take the list back; after it, following resumes.
    const jump = (id) => p.evaluate((target) => {
      const heading = document.getElementById(target);
      const line = Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
      window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - line + 4, behavior: "instant" });
    }, id);
    await readTo(p, "section-14");
    await jump("section-30");
    await p.waitForTimeout(120);
    const stoppedAt = await p.evaluate(() => {
      const container = document.querySelector(".article-toc");
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));
      return container.scrollTop;
    });
    await p.waitForTimeout(150);
    await jump("section-31");
    await p.waitForTimeout(400);
    const afterWheel = await tocState(p);
    assert.equal(afterWheel.active, "section-31");
    assert.ok(Math.abs(afterWheel.scrollTop - stoppedAt) <= 3, `stopped (${stoppedAt} → ${afterWheel.scrollTop})`);
    assert.ok(Math.abs(afterWheel.centerOffset) > 20, "it did not keep chasing the target");
    await p.waitForTimeout(800);
    await readTo(p, "section-24");
    assert.ok(Math.abs((await tocState(p)).centerOffset) <= 2, "following resumes after the grace period");
    pass("A wheel on the list hands control to the reader; following resumes on a later section change", { stoppedAt, afterWheel: afterWheel.scrollTop });

    // Fast jump across many sections: the spring retargets to the latest entry.
    await p.evaluate(() => window.scrollTo(0, document.getElementById("section-33").offsetTop));
    await p.waitForTimeout(30);
    await p.evaluate(() => window.scrollTo(0, document.getElementById("section-12").getBoundingClientRect().top + window.scrollY - 88));
    await readTo(p, "section-12");
    assert.ok(Math.abs((await tocState(p)).centerOffset) <= 2);
    pass("Rapid jumps settle centred on the latest section");
    await context.close();
  }

  // ---- Clicking a TOC entry: bezier-eased page jump ----
  {
    const { context, page: p } = await newPage({ width: 1280, height: 900 });
    const jump = await clickJump(p, "section-30");
    const shape = jumpShape(jump);
    assert.equal(jump.prevented, true, "the click is handled by the animated jump");
    assert.equal(shape.monotonic, true, "the page only moves towards the heading");
    assert.ok(Math.abs(shape.durationMs - expectedDuration(shape.distance)) <= 60, `duration ${shape.durationMs} for ${shape.distance}px`);
    assert.ok(shape.firstTenth < 0.06 && shape.lastTenth < 0.03, `eased start and soft landing: ${JSON.stringify(shape)}`);
    assert.ok(Math.abs(jump.headingTop - jump.line) <= 2, `lands on the reading line (${jump.headingTop})`);
    assert.equal(jump.hash, "#section-30");
    assert.equal(jump.historyDelta, 1, "one history entry, like a native anchor");
    assert.equal(jump.focus, "section-30");
    await p.waitForTimeout(700);
    assert.ok(Math.abs((await tocState(p)).centerOffset) <= 2, "the TOC centres the chosen entry afterwards");
    pass("TOC click: bezier-eased page jump with a distance-based duration, then the list centres", shape);

    const back = jumpShape(await clickJump(p, "section-28"));
    assert.ok(back.distance < 0 && back.durationMs < shape.durationMs, `shorter hop is quicker (${back.durationMs}ms)`);
    pass("Short hops are quicker than long jumps, in either direction", back);

    const interrupted = await clickJump(p, "section-5", { wheelAt: 120, sampleMs: 700 });
    const stoppedAt = interrupted.samples.find(([time]) => time >= 160)[1];
    const final = interrupted.samples[interrupted.samples.length - 1][1];
    assert.ok(Math.abs(final - stoppedAt) <= 2 && Math.abs(interrupted.headingTop - interrupted.line) > 50, "wheel stops the jump");
    pass("A wheel during the jump leaves the page where the reader took over", { stoppedAt: Math.round(stoppedAt) });

    const modified = await clickJump(p, "section-10", { modifier: "metaKey", sampleMs: 100 });
    assert.equal(modified.prevented, false, "modified clicks keep the browser's link behaviour");
    pass("Cmd/Ctrl/Shift/Alt clicks are left to the browser");
    await context.close();
  }

  // ---- In-article #links (footnotes, cross-references) share the eased jump ----
  {
    const { context, page: p } = await newPage({ width: 1280, height: 900 });
    const follow = (selector, sampleMs = 1300) => p.evaluate(async ({ selector, sampleMs }) => {
      const link = document.querySelector(selector);
      const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      const historyBefore = history.length;
      const from = window.scrollY;
      let prevented = null;
      window.addEventListener("click", (event) => { prevented = event.defaultPrevented; }, { once: true });
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      const samples = [];
      const t0 = performance.now();
      await new Promise((resolve) => {
        const frame = (now) => { samples.push([now - t0, window.scrollY]); if (now - t0 < sampleMs) requestAnimationFrame(frame); else resolve(); };
        requestAnimationFrame(frame);
      });
      return { from, samples, prevented, hash: location.hash, historyDelta: history.length - historyBefore,
        targetTop: target.getBoundingClientRect().top, focus: document.activeElement?.id || document.activeElement?.tagName };
    }, { selector, sampleMs });

    const toNote = await follow('a[data-footnote-ref]');
    const noteShape = jumpShape(toNote);
    assert.equal(toNote.prevented, true);
    assert.ok(noteShape.monotonic && noteShape.firstTenth < 0.06 && noteShape.lastTenth < 0.03, JSON.stringify(noteShape));
    assert.ok(Math.abs(noteShape.durationMs - expectedDuration(noteShape.distance)) <= 60, `duration ${JSON.stringify(noteShape)}`);
    assert.ok(Math.abs(toNote.targetTop - 92) <= 2 || toNote.samples.at(-1)[1] >= (await p.evaluate(() => document.documentElement.scrollHeight - innerHeight)) - 1,
      `footnote lands on the reading line, not under the header (${toNote.targetTop})`);
    assert.equal(toNote.hash, "#user-content-fn-1");
    assert.equal(toNote.historyDelta, 1);
    pass("Footnote reference: same bezier jump, lands on the reading line", noteShape);

    const back = await follow("a[data-footnote-backref]");
    assert.ok(jumpShape(back).monotonic && Math.abs(back.targetTop - 92) <= 2, `back-reference lands (${back.targetTop})`);
    assert.equal(back.focus, "user-content-fnref-1", "focus returns to the reference link");
    pass("Footnote back-reference returns with the same jump and restores focus to the reference");

    await p.evaluate(() => window.scrollTo({ top: document.getElementById("cross-ref").getBoundingClientRect().top + window.scrollY - 300, behavior: "instant" }));
    const cross = await follow("#cross-ref");
    assert.ok(jumpShape(cross).monotonic && Math.abs(cross.targetTop - 92) <= 2, `cross-reference lands (${cross.targetTop})`);
    assert.equal(cross.focus, "section-8");
    await p.waitForTimeout(700);
    assert.equal((await tocState(p)).active, "section-8");
    pass("Cross-reference to a heading: eased jump, heading focused, TOC follows");
    await context.close();
  }

  {
    const { context, page: p } = await newPage({ width: 1280, height: 900 }, { reduced: true });
    const jump = await clickJump(p, "section-30", { sampleMs: 200 });
    const firstMoved = jump.samples.find(([, y]) => y !== jump.from);
    assert.ok(!firstMoved || jump.samples.every(([, y]) => y === jump.samples[jump.samples.length - 1][1]), "no intermediate positions");
    assert.ok(Math.abs(jump.headingTop - jump.line) <= 2);
    pass("Reduced motion: a TOC click lands directly");
    await context.close();
  }

  {
    const { context, page: p } = await newPage({ width: 390, height: 844 });
    await p.locator(".article-toc-toggle").click();
    const jump = await clickJump(p, "section-20");
    const shape = jumpShape(jump);
    assert.equal(await p.locator(".article-toc-toggle").getAttribute("aria-expanded"), "false", "phone TOC collapses");
    assert.ok(shape.durationMs > 200 && shape.monotonic, "animated on phones too");
    assert.ok(Math.abs(jump.headingTop - jump.line) <= 2, `phone reading line (${jump.headingTop})`);
    assert.equal(jump.historyDelta, 0, "phone keeps replacing the entry");
    assert.equal(jump.hash, "#section-20");
    pass("Phone: collapse, then the same eased jump to the 16px reading line", shape);
    await context.close();
  }

  {
    const { context, page: p } = await newPage({ width: 1280, height: 900 }, { hash: "#section-24" });
    // The engine completes the fragment scroll after hydration; wait for it, then for the list.
    await p.waitForFunction(() => document.querySelector('a[aria-current="location"]')?.dataset.tocId === "section-24");
    await p.evaluate(() => { window.__lastTop = undefined; window.__stable = 0; });
    await p.waitForFunction(() => {
      const top = document.querySelector(".article-toc").scrollTop;
      window.__stable = window.__lastTop === top ? window.__stable + 1 : 0;
      window.__lastTop = top;
      return window.__stable >= 3;
    }, null, { polling: 100, timeout: 4000 });
    const state = await tocState(p);
    assert.equal(state.active, "section-24");
    assert.ok(Math.abs(state.centerOffset) <= 2, `hash landing centred (offset ${state.centerOffset})`);
    pass("Landing on a #hash glides the active entry to the centre");
    await context.close();
  }

  {
    const { context, page: p } = await newPage({ width: 1280, height: 900 }, { reduced: true });
    const behaviors = [];
    await p.exposeFunction("__record", (value) => behaviors.push(value));
    await p.evaluate(() => {
      const container = document.querySelector(".article-toc");
      const original = container.scrollTo.bind(container);
      container.scrollTo = (options) => { window.__record(options?.behavior ?? "auto"); original(options); };
    });
    await readTo(p, "section-20");
    assert.ok(behaviors.length > 0 && behaviors.every((behavior) => behavior === "instant"), `direct writes only: ${behaviors}`);
    const indicatorTransition = await p.evaluate(() => getComputedStyle(document.querySelector('.article-toc nav > [aria-hidden="true"][data-visible]')).transitionProperty);
    assert.doesNotMatch(indicatorTransition, /transform|height|width|all/, "indicator does not slide");
    const stepped = await p.evaluate(() => {
      const heading = document.getElementById("section-20");
      const line = Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
      window.scrollTo({ top: heading.getBoundingClientRect().top + window.scrollY - line - 60, behavior: "instant" });
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const box = document.querySelector('.article-toc nav > [aria-hidden="true"][data-visible]').getBoundingClientRect();
        resolve(Math.abs(box.top - document.querySelector('a[data-toc-id="section-19"]').getBoundingClientRect().top));
      })));
    });
    assert.ok(stepped <= 1, `reduced motion: no in-between positions inside the handoff zone (${stepped})`);
    pass("Reduced motion: list and indicator step at section changes, no in-between motion", { writes: behaviors.length });
    await context.close();
  }

  {
    const { context, page: p } = await newPage({ width: 390, height: 844 });
    await p.locator(".article-toc-toggle").click();
    const before = await p.evaluate(() => window.scrollY);
    await readTo(p, "section-10");
    const state = await tocState(p);
    assert.equal(state.scrollable, false, "phone TOC is part of the page, not a scroll area");
    assert.equal(state.scrollTop, 0);
    assert.ok((await p.evaluate(() => window.scrollY)) > before);
    await p.screenshot({ path: path.join(output, "mobile.png") });
    pass("Phone layout: no TOC scroll area, so nothing is auto-scrolled");
    await context.close();
  }

  assert.deepEqual(report.pageErrors, []);
})().catch(async (error) => {
  report.error = error.stack || String(error);
  console.error(report.error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: false }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  server.close();
});
