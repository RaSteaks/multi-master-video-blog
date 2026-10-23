const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const esbuild = require("esbuild");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

// Bundles the real AlbumGallery into a local harness and drives it in fresh headless
// WebKit contexts (never a personal browser). Synthetic touch is a regression check
// only; it does not replace testing on real iPhone/Android hardware.
const root = path.resolve(__dirname, "..");
const web = path.join(root, "apps/web");
const output = path.join(root, "test-results/album-lightbox");
const build = path.join(output, "build");
const TOKEN = "lightbox-test-token";
const report = { browser: "headless WebKit", checks: [], pageErrors: [], gaps: [] };
let browser;
let page;

function photo(id, { hdr = false, hlg = false } = {}) {
  return {
    id, sdrImage: `p${id}`, hdrImage: hdr ? `p${id}pq` : null, hlgImage: hlg ? `p${id}hlg` : null,
    thumbnailUrl: `/api/assets/p${id}?key=album-thumb`, thumbnailSrcSet: null, width: 1200, height: 800,
    sdrUrl: `/api/assets/p${id}`, hdrUrl: hdr ? `/api/assets/p${id}pq` : null, hlgUrl: hlg ? `/api/assets/p${id}hlg` : null,
    caption: `第 ${id} 张`, altText: `照片 ${id}`, hdrTransfer: hdr ? "pq" : null, hdrPrimaries: hdr ? "bt2020" : null,
    hdrBitDepth: hdr ? 10 : null, filmStock: null, filmProcess: null, filmScanner: null, filmFrameFormat: null,
    published: true, sortOrder: id,
  };
}
const photos = [photo(1), photo(2), photo(3, { hdr: true, hlg: true }), photo(4)];
const album = { id: 7, title: "灯箱测试相簿", slug: "lightbox-test", description: "", coverImage: "p1", published: true, photos };
const managedAlbum = {
  id: 7, title: album.title, slug: album.slug, description: "", coverImage: "p1", published: true,
  photoCount: 4, publishedPhotoCount: 4, hdrPhotoCount: 1, createdAt: null, updatedAt: "2026-10-23T00:00:00Z", url: "",
  photos: photos.map((item) => ({
    id: item.id, albumId: 7, sdrImage: item.sdrImage, width: 1200, height: 800, hdrImage: item.hdrImage,
    caption: item.caption, altText: item.altText, hdrTransfer: item.hdrTransfer, hdrPrimaries: item.hdrPrimaries,
    hdrBitDepth: item.hdrBitDepth, hlgImage: item.hlgImage, filmScanFrameId: null, filmStock: null, filmProcess: null,
    filmScanner: null, filmFrameFormat: null, renditions: [], published: true, sortOrder: item.sortOrder,
    createdAt: null, updatedAt: null,
  })),
};

// Per-file delay/failure, set by each check. Requests are logged with their auth header.
const control = { delays: {}, failures: new Set(), requests: [] };
const colors = ["#3b4a56", "#5a4636", "#2f5446", "#4e3f5c"];
function svg(id, thumb) {
  const [w, h] = thumb ? [600, 400] : [1200, 800];
  const n = Number(String(id).match(/\d+/)?.[0] || 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="${colors[(n - 1) % 4]}"/><text x="600" y="430" font-size="160" text-anchor="middle" fill="#e2e8ee" font-family="sans-serif">${id}</text></svg>`;
}

async function bundle() {
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, "next-link.js"),
    "import React from 'react'; export default function Link({ href, children, prefetch, ...props }) { return React.createElement('a', { href, ...props }, children); }");
  fs.writeFileSync(path.join(build, "next-navigation.js"),
    "export function useRouter() { return { push() {}, refresh() {}, replace() {} }; }");
  await esbuild.build({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client"; import { AlbumGallery } from "./src/components/AlbumGallery";
        const config = window.__LIGHTBOX_CONFIG__;
        createRoot(document.getElementById("root")).render(React.createElement(AlbumGallery, config.props));`,
      resolveDir: web, loader: "tsx",
    },
    bundle: true, jsx: "automatic", platform: "browser", format: "iife", outfile: path.join(build, "client.js"),
    alias: { "next/link": path.join(build, "next-link.js"), "next/navigation": path.join(build, "next-navigation.js") },
    nodePaths: [path.join(root, "node_modules")], define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: path.join(web, "tsconfig.json"), logLevel: "silent",
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/client.js") return send(res, fs.readFileSync(path.join(build, "client.js")), "text/javascript");
  if (url.pathname === "/client.css") return send(res, fs.readFileSync(path.join(build, "client.css")), "text/css");
  if (url.pathname === "/globals.css") return send(res, fs.readFileSync(path.join(web, "src/app/globals.css")), "text/css");
  const asset = url.pathname.match(/^\/api\/assets\/([a-z0-9]+)$/);
  if (asset) {
    const id = asset[1];
    const thumb = url.searchParams.has("key");
    control.requests.push({ path: `${url.pathname}${url.search}`, auth: req.headers.authorization || null, id, thumb, at: Date.now() });
    const delay = thumb ? 0 : control.delays[id] || 0;
    return setTimeout(() => {
      if (!thumb && control.failures.has(id)) return send(res, "missing", "text/plain", 404);
      send(res, svg(id, thumb), "image/svg+xml", 200, { "Cache-Control": "no-store" });
    }, delay);
  }
  const managed = url.searchParams.get("mode") === "managed";
  const props = managed ? { initialAlbum: album, initialManagedAlbum: managedAlbum, initialToken: TOKEN } : { initialAlbum: album };
  send(res, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/client.css"></head>
    <body><div id="root"></div><script>window.__LIGHTBOX_CONFIG__=${JSON.stringify({ props })}</script><script src="/client.js"></script></body></html>`, "text/html");
});
function send(res, body, type, status = 200, headers = {}) {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, ...headers });
  res.end(body);
}

function pass(name, value) {
  report.checks.push(value === undefined ? { name } : { name, value });
  console.log(`ok - ${name}`);
}

// Records every Element.animate call (target role, animated properties, timing) for assertions.
function instrument() {
  window.__animations = [];
  const original = Element.prototype.animate;
  Element.prototype.animate = function animate(keyframes, options) {
    const frames = Array.isArray(keyframes) ? keyframes : [];
    window.__animations.push({
      role: this.dataset?.role || (this.tagName === "DIALOG" ? "dialog" : this.className?.toString().slice(0, 40)),
      props: [...new Set(frames.flatMap((frame) => Object.keys(frame)))],
      duration: options?.duration,
      pseudo: options?.pseudoElement || null,
      at: performance.now(),
    });
    return original.call(this, keyframes, options);
  };
}

async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1280, height: 900 }, hasTouch: Boolean(options.touch) });
  await context.addInitScript(instrument);
  // Display capability is explicit per check; the host machine's own HDR screen must not leak in.
  await context.addInitScript((hdr) => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) => query.includes("dynamic-range: high")
      ? { matches: hdr, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
      : original(query);
  }, Boolean(options.hdr));
  if (options.zoomed) {
    await context.addInitScript(() => Object.defineProperty(window.visualViewport, "scale", { get: () => 2 }));
  }
  if (options.saveData) {
    await context.addInitScript(() => Object.defineProperty(navigator, "connection", { value: { saveData: true } }));
  }
  const current = await context.newPage();
  current.on("pageerror", (error) => report.pageErrors.push(error.message));
  await current.goto(`${base}/${options.managed ? "?mode=managed" : ""}`);
  await current.locator("[data-photo-tile='1'] img").waitFor();
  page = current;
  return { context, page: current };
}

const counter = (p) => p.locator(".album-lightbox-toolbar > span").innerText();
const shownAlt = (p) => p.locator('[data-role="shown"] img').getAttribute("alt");
const animationsSince = (p, mark) => p.evaluate((since) => window.__animations.filter((entry) => entry.at >= since), mark);
const now = (p) => p.evaluate(() => performance.now());

async function openFromTile(p, id = 1) {
  const mark = await now(p);
  await p.locator(`[data-photo-tile='${id}']`).click();
  await p.locator("dialog.album-lightbox[open]").waitFor();
  await p.waitForFunction(() => document.querySelector('[data-role="shown"] img'));
  return mark;
}

/** Dispatches a synthetic single-finger (or second-finger) pointer sequence on the photo area. */
async function touchPath(p, points, { pointerId = 1, isPrimary = true, release = "up", interval = 16 } = {}) {
  return p.evaluate(async ({ points, pointerId, isPrimary, release, interval }) => {
    const stage = document.querySelector('[data-role="shown"]')?.parentElement;
    const fire = (type, [x, y]) => stage.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId, pointerType: "touch", isPrimary, clientX: x, clientY: y,
      buttons: type === "pointerup" ? 0 : 1, width: 10, height: 10, pressure: type === "pointerup" ? 0 : 0.5,
    }));
    fire("pointerdown", points[0]);
    for (const point of points.slice(1)) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      fire("pointermove", point);
    }
    if (release) fire(release === "cancel" ? "pointercancel" : "pointerup", points[points.length - 1]);
  }, { points, pointerId, isPrimary, release, interval });
}
const line = (from, to, steps) => Array.from({ length: steps + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);

let base;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  await bundle();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await webkit.launch({ headless: true, ...(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });

  // ---- Desktop keyboard, open/close and focus ----
  {
    const { context, page: p } = await newPage();
    await context.tracing.start({ screenshots: true, snapshots: true });
    const mark = await openFromTile(p, 1);
    assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("aria-label")), "关闭灯箱");
    const opening = await animationsSince(p, mark);
    const morph = opening.find((entry) => entry.role === "shown" && entry.props.includes("transform"));
    assert.ok(morph, "fast SDR open morphs from the visible tile");
    assert.ok(opening.some((entry) => entry.pseudo === "::backdrop"), "backdrop fades with the morph");
    pass("Open: native modal focus, tile→photo morph and backdrop fade for a ready SDR photo", { morphDuration: morph.duration });
    await p.screenshot({ path: path.join(output, "desktop-open.png") });

    // Only p1 is shown and its neighbours p2/p4 preloaded; p3 has never loaded. Two presses in
    // one task pass through p2 (dropped before its cached load event) to the slow p3.
    await p.waitForTimeout(300);
    control.delays = { p3: 500 };
    const rapid = await now(p);
    await p.evaluate(() => {
      for (let i = 0; i < 2; i += 1) {
        document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      }
    });
    assert.equal(await counter(p), "03 / 04");
    await p.waitForTimeout(220);
    assert.equal(await shownAlt(p), "照片 1", "previous photo stays until the newest file decodes");
    assert.equal(await p.locator(".album-lightbox figure").getAttribute("aria-busy"), "true");
    assert.equal(await p.locator('[data-visible="true"]', { hasText: "载入中" }).count(), 1);
    assert.equal(await p.locator('[data-role="incoming"]').count(), 1, "only the latest request is pending");
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 3", null, { timeout: 4000 });
    await p.waitForTimeout(400);
    assert.equal(await p.locator('[data-role="incoming"]').count(), 0);
    assert.equal(await p.locator('[data-role="outgoing"]').count(), 0);
    const rapidAnimations = await animationsSince(p, rapid);
    assert.ok(rapidAnimations.filter((entry) => entry.role === "shown").length <= 1, "no queued stale transitions");
    control.delays = {};
    pass("Rapid paging on slow loads: old photo kept with a delayed hint, latest wins, no stale layers", { transitions: rapidAnimations.length });

    await p.keyboard.press("ArrowRight");
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 4");
    await p.keyboard.press("ArrowRight");
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 1");
    assert.equal(await counter(p), "01 / 04");
    await p.keyboard.press("ArrowLeft");
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 4");
    assert.equal(await counter(p), "04 / 04");
    pass("Keyboard paging keeps wrap-around in both directions");


    const closing = await now(p);
    await p.keyboard.press("Escape");
    assert.equal(await p.locator("dialog.album-lightbox").evaluate((dialog) => dialog.open), true, "close animates before dialog.close()");
    await p.locator("dialog.album-lightbox").waitFor({ state: "detached" });
    const closeAnimations = await animationsSince(p, closing);
    assert.ok(closeAnimations.some((entry) => entry.role === "shown" && entry.props.includes("transform")), "closes into the current photo's tile");
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.photoTile), "1");
    pass("Escape: animated close into the current photo's tile, then focus returns to the opener");

    // Close button and the tile-missing fallback (fade, no page scroll).
    await openFromTile(p, 2);
    const scrollBefore = await p.evaluate(() => window.scrollY);
    await p.evaluate(() => { document.querySelector("[data-photo-tile='2']").style.display = "none"; });
    const fading = await now(p);
    await p.getByRole("button", { name: "关闭灯箱" }).click();
    await p.locator("dialog.album-lightbox").waitFor({ state: "detached" });
    const fade = (await animationsSince(p, fading)).find((entry) => entry.role === "shown");
    assert.deepEqual(fade.props.sort(), ["opacity", "transform"].sort());
    assert.equal(await p.evaluate(() => window.scrollY), scrollBefore);
    await p.evaluate(() => { document.querySelector("[data-photo-tile='2']").style.display = ""; });
    pass("Close button with an unreachable tile: short fade, page not scrolled", { duration: fade.duration });

    // Keep the original opener focusable but outside the viewport; modal background
    // scrolling or a resize must not be undone by the explicit focus restoration.
    await p.evaluate(() => { document.body.style.minHeight = "5000px"; });
    await openFromTile(p, 1);
    await p.evaluate(() => window.scrollTo({ top: 2000, behavior: "instant" }));
    const scrollDuringModal = await p.evaluate(() => window.scrollY);
    assert.ok(await p.locator("[data-photo-tile='1']").evaluate((element) => element.getBoundingClientRect().bottom < 0));
    await p.keyboard.press("Escape");
    await p.locator("dialog.album-lightbox").waitFor({ state: "detached" });
    await p.waitForFunction(() => document.activeElement?.dataset.photoTile === "1");
    assert.equal(await p.evaluate(() => window.scrollY), scrollDuringModal);
    await p.screenshot({ path: path.join(output, "offscreen-opener-closed.png") });
    pass("Closing preserves page scroll while restoring focus to an offscreen opener", { scrollY: scrollDuringModal });
    await p.evaluate(() => { document.body.style.minHeight = ""; window.scrollTo({ top: 0, behavior: "instant" }); });

    // Double close request finishes immediately instead of queueing.
    await openFromTile(p, 1);
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    await p.locator("dialog.album-lightbox").waitFor({ state: "detached", timeout: 120 });
    pass("A second close request completes at once");

    await context.tracing.stop({ path: path.join(output, "desktop-trace.zip") });
    await context.close();
  }

  // ---- Close while two image layers are still visible ----
  {
    const { context, page: p } = await newPage();
    await openFromTile(p, 1);
    await p.waitForTimeout(350);
    // Stretch this token only in the harness so the interruption is deterministic.
    await p.evaluate(() => document.querySelector("dialog.album-lightbox").style.setProperty("--motion-media-duration", "1200ms"));
    await p.keyboard.press("ArrowRight");
    await p.locator('[data-role="outgoing"]').waitFor();
    await p.waitForTimeout(80);
    const outgoingBefore = await p.locator('[data-role="outgoing"]').evaluate((element) => Number(getComputedStyle(element).opacity));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(120);
    const outgoingAfter = await p.locator('[data-role="outgoing"]').evaluate((element) => Number(getComputedStyle(element).opacity));
    assert.ok(outgoingAfter < outgoingBefore, "close continues fading the departing image instead of restoring its full opacity");
    await p.screenshot({ path: path.join(output, "close-during-crossfade.png") });
    await p.keyboard.press("Escape");
    await p.locator("dialog.album-lightbox").waitFor({ state: "detached" });
    pass("Closing during a crossfade fades both image layers from their current opacity", { outgoingBefore, outgoingAfter });
    await context.close();
  }

  // ---- Slow first load (fresh cache): no late morph, just a fade when the file arrives ----
  {
    const { context, page: p } = await newPage();
    control.delays = { p3: 700 };
    const slow = await openFromTile(p, 3);
    const slowOpen = (await animationsSince(p, slow)).filter((entry) => entry.role === "shown");
    assert.deepEqual(slowOpen.map((entry) => entry.props), [["opacity"]]);
    control.delays = {};
    await p.keyboard.press("Escape");
    await p.locator("dialog.album-lightbox").waitFor({ state: "detached" });
    pass("Slow first load fades in instead of morphing late");
    await context.close();
  }

  // ---- Failure and HDR fallback (emulated HDR display) ----
  {
    const { context, page: p } = await newPage({ hdr: true });
    // p4 fails from the start, so neither the preloader nor the lightbox ever has a good copy.
    control.failures = new Set(["p3pq", "p4"]);
    const mark = await now(p);
    await openFromTile(p, 3);
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 3");
    assert.equal(await p.locator(".album-version-button.active").innerText().then((text) => text.split("\n")[0]), "HLG");
    assert.match(await p.locator(".album-version-button", { hasText: "PQ" }).innerText(), /载入失败/);
    const hdrOpen = (await animationsSince(p, mark)).filter((entry) => entry.role === "shown");
    assert.ok(hdrOpen.every((entry) => !entry.props.includes("transform")), "HDR renditions are not morphed from SDR tiles");
    pass("PQ failure falls back to HLG with the failure label; HDR opens without a tile morph");

    const switchMark = await now(p);
    await p.getByRole("button", { name: /SDR/ }).click();
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.getAttribute("src") === "/api/assets/p3");
    assert.equal((await animationsSince(p, switchMark)).filter((entry) => entry.role === "shown" || entry.role === "outgoing").length, 0);
    pass("Version comparison (HLG→SDR) is a hard cut, never a blend");

    await p.keyboard.press("ArrowRight");
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 4");
    assert.equal(await p.locator('[data-role="shown"] img').evaluate((image) => image.complete && image.naturalWidth === 0), true);
    assert.equal(await p.locator('[data-visible="true"]', { hasText: "载入中" }).count(), 0);
    pass("A failed SDR file shows its native broken state instead of keeping the previous photo");
    control.failures = new Set();
    await p.keyboard.press("ArrowRight");
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 1");
    await p.waitForTimeout(300);
    const requested = control.requests.map((entry) => entry.path);
    assert.ok(requested.includes("/api/assets/p3pq"), "HDR neighbour preloads use the PQ file the lightbox would show");
    pass("Neighbour preloading requests the display version the target will actually use");
    await context.close();
  }

  // ---- Reduced motion ----
  {
    const { context, page: p } = await newPage();
    await p.emulateMedia({ reducedMotion: "reduce" });
    const mark = await openFromTile(p, 1);
    await p.keyboard.press("ArrowRight");
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 2");
    await p.keyboard.press("Escape");
    await p.locator("dialog.album-lightbox").waitFor({ state: "detached" });
    const all = await animationsSince(p, mark);
    assert.ok(all.length > 0);
    assert.ok(all.every((entry) => !entry.props.includes("transform")), "no displacement or scale");
    assert.ok(all.every((entry) => entry.duration <= 100), "short fades only");
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.photoTile), "1");
    pass("Reduced motion: open, paging and close use ≤100ms opacity only; focus still restored", { count: all.length });
    await context.close();
  }

  // ---- Changing reduced-motion preference during a drag return ----
  {
    const { context, page: p } = await newPage({ viewport: { width: 390, height: 844 }, touch: true });
    await openFromTile(p, 1);
    await p.waitForTimeout(350);
    // A long return exposes preference changes mid-animation without relying on test-run speed.
    await p.evaluate(() => document.querySelector("dialog.album-lightbox").style.setProperty("--motion-media-duration", "2000ms"));
    await touchPath(p, line([220, 400], [180, 400], 4), { interval: 50 });
    assert.notEqual(await p.locator('[data-role="shown"]').evaluate((element) => getComputedStyle(element).transform), "none");
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-role="shown"]')).transform === "none", null, { timeout: 500 });
    assert.equal(await p.locator('[data-role="shown"]').evaluate((element) => element.getAnimations().some((animation) => animation.playState === "running")), false);
    assert.equal(await counter(p), "01 / 04");
    await p.screenshot({ path: path.join(output, "reduced-during-return.png") });
    pass("Enabling reduced motion during a drag return immediately finishes its movement");
    await context.close();
  }

  // ---- Touch gestures at phone size ----
  {
    const { context, page: p } = await newPage({ viewport: { width: 390, height: 844 }, touch: true });
    await openFromTile(p, 1);
    await p.waitForTimeout(350);
    const box = await p.locator('[data-role="shown"]').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await p.screenshot({ path: path.join(output, "mobile-open.png") });

    await touchPath(p, line([cx + 60, cy], [cx - 70, cy], 6));
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 2");
    assert.equal(await counter(p), "02 / 04");
    pass("Flick left pages forward");

    await touchPath(p, line([cx - 60, cy], [cx + 140, cy], 10), { interval: 20 });
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 1");
    await touchPath(p, line([cx - 60, cy], [cx + 140, cy], 10), { interval: 20 });
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 4");
    assert.equal(await counter(p), "04 / 04");
    pass("Swipe right pages back and wraps from the first photo to the last (no edge resistance)");

    await touchPath(p, [[cx, cy], [cx + 3, cy + 2], [cx + 2, cy - 1]]);
    await touchPath(p, line([cx, cy], [cx - 30, cy], 3), { interval: 60 });
    await p.waitForTimeout(300);
    assert.equal(await counter(p), "04 / 04");
    assert.equal(await p.locator('[data-role="shown"]').evaluate((el) => getComputedStyle(el).transform), "none");
    pass("Taps and short slow drags return without paging");

    await touchPath(p, line([cx, cy], [cx, cy - 120], 6));
    await touchPath(p, line([cx, cy], [cx + 80, cy + 78], 6));
    assert.equal(await counter(p), "04 / 04");
    assert.equal(await p.locator("dialog.album-lightbox").count(), 1);
    pass("Upward and ambiguous diagonal drags are ignored");

    // Second finger joins mid-swipe: hand over to the browser, no navigation.
    await touchPath(p, line([cx + 60, cy], [cx - 20, cy], 4), { release: null });
    await touchPath(p, [[cx + 40, cy + 40]], { pointerId: 2, isPrimary: false, release: null });
    await touchPath(p, line([cx - 20, cy], [cx - 120, cy], 4), { release: "up" });
    await p.evaluate(() => document.querySelector('[data-role="shown"]').parentElement.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 2, pointerType: "touch" })));
    await p.waitForTimeout(300);
    assert.equal(await counter(p), "04 / 04");
    pass("A second finger cancels the gesture and returns the photo");

    // pointercancel (e.g. the browser takes over for pinch-zoom) never pages.
    await touchPath(p, line([cx + 60, cy], [cx - 160, cy], 6), { release: "cancel" });
    await p.waitForTimeout(300);
    assert.equal(await counter(p), "04 / 04");
    pass("pointercancel returns without paging");

    // Grab during the return animation: continue from the drawn position.
    await touchPath(p, line([cx, cy], [cx - 50, cy], 4), { interval: 50 });
    const grabbed = await p.evaluate(() => {
      const layer = document.querySelector('[data-role="shown"]');
      const stage = layer.parentElement;
      stage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 5, pointerType: "touch", isPrimary: true, clientX: 200, clientY: 300 }));
      const transform = layer.style.transform;
      stage.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 5, pointerType: "touch", isPrimary: true, clientX: 200, clientY: 300 }));
      return transform;
    });
    assert.match(grabbed, /translate3d\(-\d/);
    pass("Re-grabbing mid-return continues from the current drawn position", { grabbed });

    // Pull down to dismiss: chrome recedes during the drag, then the shared close path runs.
    await touchPath(p, line([cx, cy], [cx, cy + 120], 6), { release: null });
    const midDrag = await p.evaluate(() => getComputedStyle(document.querySelector(".album-lightbox-toolbar")).opacity);
    assert.ok(Number(midDrag) < 1);
    await p.screenshot({ path: path.join(output, "mobile-pull-down.png") });
    await touchPath(p, [[cx, cy + 120], [cx, cy + 170]], { pointerId: 1 });
    await p.locator("dialog.album-lightbox").waitFor({ state: "detached" });
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.photoTile), "1");
    pass("Pull-down dismisses through the shared close path and restores focus", { toolbarOpacityMidDrag: Number(midDrag) });

    // Short pull returns.
    await openFromTile(p, 1);
    await p.waitForTimeout(350);
    await touchPath(p, line([cx, cy], [cx, cy + 50], 5), { interval: 50 });
    await p.waitForTimeout(350);
    assert.equal(await p.locator("dialog.album-lightbox[open]").count(), 1);
    assert.equal(await p.evaluate(() => document.querySelector("dialog.album-lightbox").style.getPropertyValue("--lb-dismiss")), "");
    pass("A short slow pull-down returns and restores the chrome");
    await context.close();
  }

  // ---- Zoomed page: the browser keeps panning ----
  {
    const { context, page: p } = await newPage({ viewport: { width: 390, height: 844 }, touch: true, zoomed: true });
    await openFromTile(p, 1);
    await p.waitForTimeout(350);
    assert.equal(await p.locator('[data-role="shown"]').evaluate((el) => el.parentElement.dataset.pageZoomed), "true");
    assert.equal(await p.locator('[data-role="shown"]').evaluate((el) => getComputedStyle(el.parentElement).touchAction), "auto");
    const box = await p.locator('[data-role="shown"]').boundingBox();
    await touchPath(p, line([box.x + box.width / 2 + 60, box.y + 100], [box.x + 10, box.y + 100], 6));
    await p.waitForTimeout(250);
    assert.equal(await counter(p), "01 / 04");
    pass("With the page zoomed, swipes are left to browser panning (touch-action: auto)");
    await context.close();
  }

  // ---- Save-Data: no speculative downloads ----
  {
    const { context, page: p } = await newPage({ saveData: true });
    const before = control.requests.length;
    await openFromTile(p, 2);
    await p.waitForTimeout(400);
    const full = control.requests.slice(before).filter((entry) => !entry.thumb).map((entry) => entry.id);
    assert.deepEqual(full, ["p2"]);
    pass("Save-Data: only the photo being viewed is downloaded");
    await context.close();
  }

  // ---- Protected (management) images keep their authentication boundary ----
  {
    const before = control.requests.length;
    const { context, page: p } = await newPage({ managed: true });
    await openFromTile(p, 1);
    await p.keyboard.press("ArrowRight");
    await p.waitForFunction(() => document.querySelector('[data-role="shown"] img')?.alt === "照片 2");
    await p.waitForTimeout(400);
    const requests = control.requests.slice(before);
    const anonymous = requests.filter((entry) => entry.auth !== `Bearer ${TOKEN}`);
    assert.deepEqual(anonymous, [], "every protected asset request carries the bearer token");
    assert.equal(requests.some((entry) => entry.path.includes(TOKEN)), false, "token never in a URL");
    const full = requests.filter((entry) => !entry.thumb).map((entry) => entry.id);
    assert.deepEqual([...new Set(full)].sort(), ["p1", "p2"], "management mode does not preload neighbours");
    assert.match(await p.locator('[data-role="shown"] img').getAttribute("src"), /^blob:/);
    pass("Management mode: authenticated blob fetches only, no anonymous or speculative requests", { requests: requests.length });
    await context.close();
  }

  assert.deepEqual(report.pageErrors, []);
  report.gaps.push(
    "Synthetic PointerEvents only: real iPhone/Android touch, velocity feel and pinch-zoom interplay need device testing.",
    "HDR display was emulated via matchMedia; screenshots cannot verify HDR brightness.",
    "::backdrop custom-property inheritance (pull-down reveal) is engine-dependent; verify on Safari iOS and Chrome Android.",
  );
})().catch(async (error) => {
  report.error = error.stack || String(error);
  console.error(report.error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  server.close();
});
