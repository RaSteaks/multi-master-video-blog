const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const esbuild = require("esbuild");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

// Bundles the real MediaPlayer into a local harness and drives it in fresh headless
// WebKit contexts. HLS comes from the running local stack (MEDIA_ORIGIN, default the
// Next dev server, which proxies /media to the API) and is re-served same-origin, with
// optional delay or 404 per master. Screenshots never prove HDR brightness.
const root = path.resolve(__dirname, "..");
const web = path.join(root, "apps/web");
const output = path.join(root, "test-results/media-player");
const build = path.join(output, "build");
const mediaOrigin = process.env.MEDIA_ORIGIN || "http://127.0.0.1:3000";
const SDR = "/media/local-cms-preview-video/sdr/1791963397891-sdr/master.m3u8";
const HLG = "/media/local-cms-preview-video/hlg/1791963397672-hlg/master.m3u8";
const report = { browser: "headless WebKit", mediaOrigin, checks: [], pageErrors: [], gaps: [] };
let browser;
let page;

function master(id, label, type, hlsUrl, isDefault = false) {
  return {
    id, project_id: 1, label, type, hls_url: hlsUrl, file_url: null, codec: type === "sdr" ? "H.264 / AVC" : "HEVC / H.265",
    resolution_width: 640, resolution_height: 360, color_space: null, transfer_function: null, bit_depth: type === "sdr" ? 8 : 10,
    bitrate_mbps: null, dolby_profile: null, dolby_level: null, dolby_compatibility_id: null, dolby_rpu_present: null,
    dolby_el_present: null, dolby_bl_present: null, is_default: isDefault ? 1 : 0, sort_order: id, status: "published",
    processing_mode: "copy", is_derivative: 0, derived_from_master_id: null, display_gamut: type === "sdr" ? "bt709" : "bt2020",
    color_primaries: null, color_transfer: null, matrix_coefficients: null, color_range: null, pixel_format: null,
    chroma_location: null, hls_video_range: type === "sdr" ? "SDR" : type === "hlg" ? "HLG" : "PQ",
    verification_status: "ready", verified_at: null, conversion_intent: null, uploaded_at: null,
  };
}
// Keys 1–3 map to the first three; the broken masters are reachable by button only.
const masters = [
  master(11, "SDR A", "sdr", SDR, true),
  master(12, "SDR B", "sdr", `/slow/700${SDR}`),
  master(13, "HLG", "hlg", HLG),
  master(14, "SDR 损坏", "sdr", "/missing/sdr/master.m3u8"),
  master(15, "HDR10 损坏", "hdr10", "/missing/hdr10/master.m3u8"),
];

async function bundle() {
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, "next-link.js"),
    "import React from 'react'; export default function Link({ href, children, prefetch, ...props }) { return React.createElement('a', { href, ...props }, children); }");
  fs.writeFileSync(path.join(build, "next-server.js"), "export async function connection() {}");
  await esbuild.build({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client"; import { MediaPlayer } from "./src/components/MediaPlayer";
        const root = createRoot(document.getElementById("root"));
        root.render(React.createElement(MediaPlayer, { masters: window.__MASTERS__, videoProjectId: 1 }));
        window.__unmountPlayer = () => root.unmount();`,
      resolveDir: web, loader: "tsx",
    },
    bundle: true, jsx: "automatic", platform: "browser", format: "iife", outfile: path.join(build, "client.js"),
    alias: { "next/link": path.join(build, "next-link.js"), "next/server": path.join(build, "next-server.js") },
    nodePaths: [path.join(root, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    tsconfig: path.join(web, "tsconfig.json"), logLevel: "silent",
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/client.js") return send(res, fs.readFileSync(path.join(build, "client.js")), "text/javascript");
  if (url.pathname === "/client.css") return send(res, fs.readFileSync(path.join(build, "client.css")), "text/css");
  if (url.pathname === "/globals.css") return send(res, fs.readFileSync(path.join(web, "src/app/globals.css")), "text/css");
  if (url.pathname.startsWith("/missing/")) return send(res, "missing", "text/plain", 404);
  const slow = url.pathname.match(/^\/slow\/(\d+)(\/media\/.*)$/);
  if (slow || url.pathname.startsWith("/media/")) {
    const target = slow ? slow[2] : url.pathname;
    return setTimeout(() => proxy(target + url.search, res), slow ? Number(slow[1]) : 0);
  }
  if (url.pathname.startsWith("/api/")) return send(res, "", "text/plain", 204);
  send(res, `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/client.css"></head>
    <body><main class="shell page-stack" style="padding-top:24px"><div id="root"></div><button id="outside">页面其他位置</button></main>
    <script>window.__MASTERS__=${JSON.stringify(masters)}</script><script src="/client.js"></script></body></html>`, "text/html");
});
function proxy(target, res) {
  http.get(`${mediaOrigin}${target}`, (upstream) => {
    res.writeHead(upstream.statusCode || 502, { "Content-Type": upstream.headers["content-type"] || "application/octet-stream" });
    upstream.pipe(res);
  }).on("error", () => send(res, "upstream unavailable", "text/plain", 502));
}
function send(res, body, type, status = 200) {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
  res.end(body);
}

function pass(name, value) {
  report.checks.push(value === undefined ? { name } : { name, value });
  console.log(`ok - ${name}`);
}

// Observes the freeze frame, the status chip and the live region so assertions can check
// ordering (e.g. the hold is released only after a presented frame) rather than end states.
function instrument() {
  window.__events = [];
  const record = (type, detail) => window.__events.push({ type, detail, at: performance.now() });
  new MutationObserver(() => {
    const canvas = document.querySelector(".player-frame canvas");
    const video = document.querySelector("video");
    const live = document.querySelector('[role="status"][aria-live="polite"]');
    const chip = document.querySelector('.player-frame p[aria-hidden="true"]');
    if (canvas) {
      const visible = canvas.dataset.visible === "true";
      if (visible !== window.__freezeVisible) {
        window.__freezeVisible = visible;
        record(visible ? "freeze-on" : "freeze-off", { readyState: video?.readyState, seeking: video?.seeking, time: video?.currentTime });
      }
    }
    if (live && live.textContent !== window.__announcement) {
      window.__announcement = live.textContent;
      if (live.textContent) record("announce", live.textContent);
    }
    if (chip) {
      const state = `${chip.dataset.visible}|${chip.textContent}`;
      if (state !== window.__chip) {
        window.__chip = state;
        record("chip", { visible: chip.dataset.visible === "true", text: chip.textContent });
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  for (const type of ["emptied", "loadedmetadata", "loadeddata", "seeking", "seeked", "playing", "pause"]) {
    document.addEventListener(type, (event) => {
      if (event.target instanceof HTMLVideoElement) record(`video:${type}`, { time: event.target.currentTime });
    }, true);
  }
  // The host machine's real HDR screen must not leak into automatic master selection.
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query) => /dynamic-range: high/.test(query)
    ? { matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
    : original(query);
}

async function newPage(viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(instrument);
  const current = await context.newPage();
  current.on("pageerror", (error) => report.pageErrors.push(error.message));
  await current.goto(base);
  await ready(current, "SDR A");
  page = current;
  return { context, page: current };
}

const video = (p) => p.locator("video");
const active = (p) => p.locator(".master-button.active .master-button-label > span").first().innerText();
const events = (p, since) => p.evaluate((mark) => window.__events.filter((event) => event.at >= mark), since);
const now = (p) => p.evaluate(() => performance.now());
async function ready(p, label) {
  await p.waitForFunction((expected) => {
    const element = document.querySelector("video");
    const current = document.querySelector(".master-button.active .master-button-label > span")?.textContent;
    return current === expected && element && element.readyState >= 2 && !element.seeking &&
      document.querySelector(".player-frame canvas")?.dataset.visible !== "true";
  }, label, { timeout: 20000 });
}
async function seekTo(p, time) {
  await video(p).evaluate((element, t) => new Promise((resolve) => {
    element.addEventListener("seeked", resolve, { once: true });
    element.currentTime = t;
  }), time);
}
async function settle(p, label) {
  await ready(p, label);
  // Wait for the "switched" confirmation to run its course.
  await p.waitForFunction(() => document.querySelector('.player-frame p[aria-hidden="true"]')?.dataset.visible !== "true", null, { timeout: 5000 });
}

let base;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  await bundle();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await webkit.launch({ headless: true, ...(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });

  // ---- Paused SDR→SDR switch on a slow master: freeze, delayed hint, confirmed completion ----
  {
    const { context, page: p } = await newPage();
    await context.tracing.start({ screenshots: true, snapshots: true });
    // The local preview clip is 2 s long, so positions stay inside it.
    await seekTo(p, 1.2);
    const mark = await now(p);
    await p.getByRole("button", { name: "Switch to SDR B (sdr)" }).click();
    assert.equal(await p.getByRole("button", { name: "Switch to SDR B (sdr)" }).getAttribute("aria-pressed"), "true");
    assert.equal(await p.locator(".player-frame canvas").getAttribute("data-visible"), "true", "outgoing SDR frame is held");
    await p.waitForTimeout(90);
    assert.notEqual(await p.locator('.player-frame p[aria-hidden="true"]').getAttribute("data-visible"), "true", "no hint before the threshold");
    await p.waitForFunction(() => document.querySelector('.player-frame p[aria-hidden="true"]')?.dataset.visible === "true", null, { timeout: 1000 });
    assert.equal(await p.locator('.player-frame p[aria-hidden="true"]').innerText(), "正在切换到 SDR B");
    await p.waitForTimeout(160); // let the hint finish fading in for the record screenshot
    await p.screenshot({ path: path.join(output, "switching-desktop.png") });
    await settle(p, "SDR B");
    const log = await events(p, mark);
    const off = log.find((event) => event.type === "freeze-off");
    assert.ok(off && off.detail.readyState >= 2 && !off.detail.seeking, "hold released only after the new frame is available");
    assert.ok(Math.abs(off.detail.time - 1.2) < 0.3, `time kept at release (${off.detail.time})`);
    const announcements = log.filter((event) => event.type === "announce").map((event) => event.detail);
    assert.deepEqual(announcements, ["正在切换到 SDR B", "已切换到 SDR B"]);
    const done = log.findIndex((event) => event.type === "chip" && event.detail.text === "已切换到 SDR B");
    assert.ok(done > log.indexOf(off), "'switched' is claimed only after the picture is shown");
    assert.equal(await video(p).evaluate((element) => element.paused), true);
    assert.ok(Math.abs((await video(p).evaluate((element) => element.currentTime)) - 1.2) < 0.3);
    pass("Paused slow SDR→SDR switch: held frame, hint after 150ms, release after presented frame, time and pause kept", {
      freezeReleasedAfterMs: Math.round(off.at - mark), announcements,
      seeks: log.filter((event) => event.type.startsWith("video:seek")).map((event) => `${event.type.slice(6)}@${event.detail.time}`),
    });

    // Fast completion: no busy hint flashes.
    const fast = await now(p);
    await p.getByRole("button", { name: "Switch to SDR A (sdr)" }).click();
    await settle(p, "SDR A");
    const fastChips = (await events(p, fast)).filter((event) => event.type === "chip" && event.detail.visible);
    const busy = fastChips.filter((event) => event.detail.text.startsWith("正在"));
    pass("Fast switch shows the confirmation without a busy flash when under the threshold", {
      busyShown: busy.length > 0, durationMs: Math.round((await now(p)) - fast),
    });
    await context.tracing.stop({ path: path.join(output, "switch-trace.zip") });
    await context.close();
  }

  // ---- Playing switch via keyboard, filters, rapid switching ----
  {
    const { context, page: p } = await newPage();
    // Loop the 2 s clip so "playing" survives the whole check.
    await video(p).evaluate((element) => { element.muted = true; element.loop = true; return element.play(); });
    await p.waitForTimeout(400);
    await video(p).focus();
    const before = await video(p).evaluate((element) => element.currentTime);
    await p.keyboard.press("3");
    await settle(p, "HLG");
    const after = await video(p).evaluate((element) => ({ time: element.currentTime, paused: element.paused }));
    assert.equal(after.paused, false, "play intent kept");
    assert.ok(after.time >= before - 0.4, `time kept (${before} → ${after.time})`);
    pass("Key 3 inside the player switches while playing; play intent and time kept", { before, after });

    const fromHdr = await now(p);
    await p.keyboard.press("1");
    await settle(p, "SDR A");
    assert.equal((await events(p, fromHdr)).some((event) => event.type === "freeze-on"), false);
    pass("Leaving an HDR master never holds an SDR still of it");

    // Filters: outside focus, modifiers, auto-repeat, IME composition, typing in a field.
    await p.locator("#outside").focus();
    await p.keyboard.press("2");
    await video(p).focus();
    for (const key of ["Shift+2", "Control+2", "Alt+2", "Meta+2"]) await p.keyboard.press(key);
    await video(p).evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "2", repeat: true, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "2", isComposing: true, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", keyCode: 229, bubbles: true, cancelable: true }));
    });
    await p.evaluate(() => {
      const input = document.createElement("input");
      input.id = "inside-input";
      document.querySelector(".player-controls-row").append(input);
    });
    await p.locator("#inside-input").focus();
    await p.keyboard.type("2");
    assert.equal(await p.locator("#inside-input").inputValue(), "2", "the field keeps its digit");
    await p.waitForTimeout(300);
    assert.equal(await active(p), "SDR A");
    await p.evaluate(() => document.querySelector("#inside-input").remove());
    pass("Digits are ignored outside the player, with modifiers, on auto-repeat, during IME composition and in fields");

    await video(p).focus();
    const requests = [];
    const onRequest = (request) => { if (request.url().includes(".m3u8")) requests.push(request.url()); };
    p.on("request", onRequest);
    await p.keyboard.press("1");
    await p.waitForTimeout(300);
    p.off("request", onRequest);
    assert.deepEqual(requests, [], "pressing the active master's key does not reload it");
    pass("The active master's key is a no-op (no reload)");

    // Rapid 2 → 3 → 1: only the last intent completes and is announced.
    const playingBefore = await video(p).evaluate((element) => !element.paused);
    const rapid = await now(p);
    await video(p).evaluate((element) => {
      for (const key of ["2", "3", "1"]) element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    assert.equal(await active(p), "SDR A");
    await p.waitForTimeout(50);
    await settle(p, "SDR A");
    const log = await events(p, rapid);
    const announced = log.filter((event) => event.type === "announce").map((event) => event.detail);
    assert.ok(announced.every((text) => text.endsWith("SDR A")), `no stale announcements: ${announced}`);
    assert.equal(await video(p).evaluate((element) => !element.paused), playingBefore, "play intent survives rapid switching");
    pass("Rapid switching: latest intent wins, no stale hints or announcements, play intent kept", { announced });
    await context.close();
  }

  // ---- Returning to an in-flight master within one React batch ----
  {
    const { context, page: p } = await newPage();
    await seekTo(p, 1.2);
    await p.getByRole("button", { name: "Switch to SDR B (sdr)" }).click();
    await p.waitForTimeout(100);
    // B is already active but still loading: 1→2 must replace the invalidated B
    // request even though the batch ends with the same rendered master id.
    await video(p).evaluate((element) => {
      for (const key of ["1", "2"]) element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await settle(p, "SDR B");
    assert.ok(Math.abs((await video(p).evaluate((element) => element.currentTime)) - 1.2) < 0.3);
    assert.equal(await video(p).evaluate((element) => element.paused), true);
    assert.equal(await p.locator(".player-frame canvas").getAttribute("data-visible"), null);
    pass("A batch returning to the still-loading master replaces its request and releases the held frame");
    await context.close();
  }

  // ---- A play() promise that never settles cannot hold the old frame forever ----
  {
    const { context, page: p } = await newPage();
    await video(p).evaluate((element) => { element.muted = true; element.loop = true; return element.play(); });
    await p.waitForTimeout(200);
    await p.evaluate(() => {
      HTMLMediaElement.prototype.play = function play() {
        window.__pendingPlayStarted = performance.now();
        return new Promise(() => {});
      };
    });
    await p.getByRole("button", { name: "Switch to SDR B (sdr)" }).click();
    await p.waitForFunction(() => window.__pendingPlayStarted, null, { timeout: 10000 });
    await p.waitForFunction(() => document.querySelector(".player-frame canvas")?.dataset.visible !== "true", null, { timeout: 3500 });
    const heldAfterPlayMs = await p.evaluate(() => performance.now() - window.__pendingPlayStarted);
    assert.ok(heldAfterPlayMs < 3000, `frame hold remains bounded when play() stalls (${heldAfterPlayMs}ms)`);
    assert.equal(await active(p), "SDR B");
    pass("A pending play() cannot bypass the frame timeout or retain the outgoing canvas", { heldAfterPlayMs });
    await context.close();
  }

  // ---- Failures, fallback and refused play() ----
  {
    const { context, page: p } = await newPage();
    const mark = await now(p);
    await p.getByRole("button", { name: "Switch to SDR 损坏 (sdr)" }).click();
    await p.locator(".player-error[role='alert']").waitFor({ timeout: 20000 });
    assert.equal(await p.locator(".player-frame canvas").getAttribute("data-visible"), null, "error releases the held frame");
    const log = await events(p, mark);
    assert.equal(log.some((event) => event.type === "announce" && event.detail.startsWith("已切换")), false);
    assert.notEqual(await p.locator('.player-frame p[aria-hidden="true"]').getAttribute("data-visible"), "true");
    await p.screenshot({ path: path.join(output, "error.png") });
    pass("A failing SDR master shows its error at once, never claims success, and drops the held frame");

    await p.getByRole("button", { name: "Retry playback" }).waitFor();
    await p.getByRole("button", { name: "Switch to SDR A (sdr)" }).click();
    await settle(p, "SDR A");
    await p.getByRole("button", { name: "Switch to HDR10 损坏 (hdr10)" }).click();
    await p.locator(".player-warning[role='status']", { hasText: "Using SDR A" }).waitFor({ timeout: 20000 });
    await ready(p, "SDR A");
    pass("A failing HDR master keeps the existing SDR fallback");

    // Browser refuses play(): the switch still completes on the paused frame, no error.
    await video(p).evaluate((element) => { element.muted = true; element.loop = true; return element.play(); });
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function play() {
        HTMLMediaElement.prototype.play = original;
        return Promise.reject(new DOMException("Not allowed", "NotAllowedError"));
      };
    });
    const refused = await now(p);
    await p.getByRole("button", { name: "Switch to HLG (hlg)" }).click();
    await settle(p, "HLG");
    const refusedLog = await events(p, refused);
    assert.ok(refusedLog.some((event) => event.type === "announce" && event.detail === "已切换到 HLG"));
    assert.equal(await p.locator(".player-error").count(), 0);
    pass("A refused play() still completes the switch on the presented frame without an error");
    await context.close();
  }

  // ---- Missing frame signals and a seek that never reaches its target ----
  {
    const { context, page: p } = await newPage();
    await seekTo(p, 1.2);
    const mark = await now(p);
    await p.getByRole("button", { name: "Switch to SDR B (sdr)" }).click();
    // Simulate a decoder that ignores both the initial seek and its correction.
    // The old picture must still be released, without announcing a successful switch.
    await video(p).evaluate((element) => {
      Object.defineProperty(element, "currentTime", { configurable: true, get: () => 0, set: () => {} });
    });
    await ready(p, "SDR B");
    const log = await events(p, mark);
    assert.equal(log.some((event) => event.type === "announce" && event.detail.startsWith("已切换")), false);
    pass("An unconfirmed target position releases the held frame without claiming switch success");
    await context.close();

    const { context: stalledContext, page: stalled } = await newPage();
    const start = await now(stalled);
    await video(stalled).evaluate((element) => {
      // Support is present, but no compositor callback arrives: readyState alone
      // must not beat the timeout and produce an unverified success announcement.
      element.requestVideoFrameCallback = () => 1;
      element.cancelVideoFrameCallback = () => {};
    });
    await stalled.getByRole("button", { name: "Switch to SDR B (sdr)" }).click();
    await ready(stalled, "SDR B");
    const stalledLog = await events(stalled, start);
    assert.equal(stalledLog.some((event) => event.type === "announce" && event.detail.startsWith("已切换")), false);
    pass("A missing compositor callback times out without a false success announcement");
    await stalledContext.close();
  }

  // ---- Unmount mid-switch, reduced motion, phone size ----
  {
    const { context, page: p } = await newPage({ width: 390, height: 844 });
    await p.emulateMedia({ reducedMotion: "reduce" });
    const chip = p.locator('.player-frame p[aria-hidden="true"]');
    assert.equal(await chip.evaluate((element) => getComputedStyle(element).transform), "none");
    // globals.css may narrow transition-property further; movement must simply never be animated.
    assert.doesNotMatch(await chip.evaluate((element) => getComputedStyle(element).transitionProperty), /transform|translate|all/);
    pass("Reduced motion: the status hint only fades (no movement)");

    await p.getByRole("button", { name: "Switch to SDR B (sdr)" }).click();
    await p.waitForTimeout(260);
    await p.screenshot({ path: path.join(output, "switching-mobile.png") });
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await p.evaluate(() => window.__unmountPlayer());
    await p.waitForTimeout(1200);
    assert.equal(await p.locator("video").count(), 0);
    pass("390px layout has no horizontal overflow; unmounting mid-switch leaves no errors");
    await context.close();
  }

  assert.deepEqual(report.pageErrors, []);
  report.gaps.push(
    "Single decoder: switches from HDR masters (and any switch when capture fails) can still show black while loading.",
    "HDR rendering and HDR→SDR transitions cannot be judged from screenshots; check on a real HDR display.",
    "Native-HLS (Safari HDR path) frame capture of cross-origin media is only covered by unit tests (tainted canvas → no hold).",
    "Freeze frame covers the native controls while held; check this on iOS/Android players.",
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
