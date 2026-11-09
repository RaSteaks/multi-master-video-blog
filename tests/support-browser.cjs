const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "test-results/support");
// Keep the test port separate from the deliverable preview on 13029.
const url = "http://127.0.0.1:13030";
const report = { browser: "headless WebKit", checks: [], pageErrors: [], passed: false };
const children = [];
let browser;
let page;
let offline = true;
let cmsAbout = false;
let backendRequests = 0;

// This sentinel is deliberately unavailable during standalone-page checks. It
// supplies disposable data only for the existing home/About entry-point checks.
const backend = http.createServer((req, res) => {
  backendRequests++;
  res.setHeader("Content-Type", "application/json");
  if (offline) { res.writeHead(503); res.end('{}'); return; }
  const request = new URL(req.url, "http://fixture");
  const data = request.pathname === "/items/site_settings" ? null
    : request.searchParams.has("aggregate[count]") ? [{ count: "0" }]
    : cmsAbout && request.searchParams.get("filter[slug][_eq]") === "about"
      ? [{ id: 1, title: "测试关于页", slug: "about", content: "测试正文", published: true }]
      : [];
  res.end(JSON.stringify({ data }));
});

function start(command, args, env, name) {
  const log = fs.openSync(path.join(output, `${name}.log`), "w");
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  children.push(child);
  return child;
}
function pass(name) { report.checks.push(name); console.log(`PASS ${name}`); }

const RIDE = ["playback-upload", "playback-probe", "color-contract", "playback-package", "color-preserve", "color-sdr",
  "playback-select", "playback-decode", "color-samples", "color-transfer", "color-display", "playback-recover"];

async function settleStop(id) {
  // A stop becomes active before a native smooth scroll has finished. Wait for
  // actual anchor alignment before sending an independent wheel gesture.
  await page.waitForFunction(id => {
    const stage = document.getElementById(id);
    const line = parseFloat(document.querySelector(".journey").style.getPropertyValue("--reading-offset"));
    return stage.hasAttribute("data-active") && Math.abs(stage.getBoundingClientRect().top - line) < 2;
  }, id);
  await page.evaluate(() => new Promise((resolve, reject) => {
    let last = scrollY;
    let stable = 0;
    let frames = 0;
    function sample() {
      stable = scrollY === last ? stable + 1 : 0;
      last = scrollY;
      if (stable >= 6) return resolve();
      if (++frames > 180) return reject(new Error("Native stop scroll did not settle"));
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }));
}

async function main() {
  await fsp.mkdir(output, { recursive: true });
  await fsp.writeFile(path.join(output, "tsconfig.json"), JSON.stringify({
    extends: "../../apps/web/tsconfig.json",
    include: ["../../apps/web/src/**/*.ts", "../../apps/web/src/**/*.tsx", "../../apps/web/next-env.d.ts"],
  }));
  await new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.listen(0, "127.0.0.1", resolve);
  });
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;
  const env = {
    NEXT_DIST_DIR: "../../test-results/support/next", NEXT_TSCONFIG_PATH: "../../test-results/support/tsconfig.json",
    API_INTERNAL_URL: backendUrl, DIRECTUS_URL: backendUrl, NEXT_PUBLIC_DIRECTUS_URL: backendUrl,
    DIRECTUS_EMAIL: "", DIRECTUS_PASSWORD: "", DIRECTUS_TOKEN: "", DIRECTUS_REVALIDATE: "0",
    CMS_RUNTIME_ONLY: "true", RESOURCE_PROFILE: "low-2gb",
  };
  const build = start("npm", ["run", "build:web"], env, "build");
  const exitCode = await new Promise((resolve, reject) => { build.once("exit", resolve); build.once("error", reject); });
  assert.equal(exitCode, 0, "Production build; see test-results/support/build.log");
  pass("production build and TypeScript");
  const web = start(process.execPath, [require.resolve("next/dist/bin/next"), "start", "apps/web", "-H", "127.0.0.1", "-p", "13030"], env, "web");
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(web.exitCode, null, "Isolated server exited; see test-results/support/web.log");
    try { if ((await fetch(`${url}/support`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } }
    catch { /* Isolated Next server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, "Static /support route becomes available");
  browser = await webkit.launch({ headless: true, executablePath: process.env.WEBKIT_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  const requests = [];
  page.on("request", request => requests.push(request.url()));
  const response = await page.goto(`${url}/support`, { waitUntil: "networkidle" });
  assert.equal(response.status(), 200);
  assert.equal(await page.title(), "播放与色彩支持");
  assert.equal(backendRequests, 0, "No backend requests, including the layout, while CMS/API are unavailable");
  assert.ok(requests.every(request => request.startsWith(`${url}/support`)), "Only local static page assets requested");
  pass("/support loads with zero CMS/API requests and no remote dependencies");
  await page.screenshot({ path: path.join(output, "desktop.png") });

  // A direct visit has no page to step back to: the breadcrumb leads home and
  // the header carries the site's sections in the main navigation's order.
  assert.equal(await page.locator(".site-header .back").isHidden(), true);
  assert.equal(await page.locator(".crumbs a").getAttribute("href"), "/");
  assert.equal(await page.locator(".identity[aria-current='page']").textContent(), "播放与色彩支持");
  assert.deepEqual(await page.locator(".site-nav a").evaluateAll(links => links.map(link => [link.getAttribute("href"), link.textContent.trim()])),
    [["/videos", "视频"], ["/posts", "文章"], ["/albums", "相簿"], ["/project", "实验室"], ["/about", "关于"]]);
  assert.equal(await page.locator(".footer-exit a").first().getAttribute("href"), "/videos");
  pass("header breadcrumb, site sections and the guide's closing exit");

  // One ride through both lines: every station on the map reaches its stop,
  // and the in-car display, map state and article agree.
  const stations = page.locator(".network .station");
  assert.equal(await stations.count(), 12);
  for (let index = 0; index < RIDE.length; index++) {
    await page.locator(`.network .station[href="#${RIDE[index]}"]`).click();
    await settleStop(RIDE[index]);
    assert.equal(await page.locator("[data-readout='count']").textContent(), `${String(index + 1).padStart(2, "0")} / 12`);
    assert.equal(await page.locator(".network .station[aria-current='location']").getAttribute("href"), `#${RIDE[index]}`);
    assert.equal(await page.locator(".network .station.is-passed").count(), index + 1);
    if (index === 4) await page.screenshot({ path: path.join(output, "story-interchange.png") });
    assert.equal(await page.locator(".stage:visible").count(), 12, "All stops stay in document flow");
  }
  assert.equal(await page.getByRole("button", { name: "下一站" }).isDisabled(), true);
  await page.getByRole("button", { name: "上一站" }).click();
  assert.ok(page.url().endsWith("#color-display"));
  await settleStop("color-display");
  await page.reload({ waitUntil: "networkidle" });
  await settleStop("color-display");
  await page.locator(".network .station").first().focus();
  await page.keyboard.press("Enter");
  await settleStop("playback-upload");
  assert.equal(await page.getByRole("button", { name: "上一站" }).isDisabled(), true);
  await page.getByRole("button", { name: "下一站" }).click();
  await settleStop("playback-probe");
  await page.locator('.stage a.transfer[href="#color-contract"]').click();
  await settleStop("color-contract");
  pass("all 12 stops, station links, transfers, keyboard, navigation boundaries and deep-link reload");

  await page.locator(".network .station").first().click();
  await settleStop("playback-upload");
  await page.mouse.move(400, 600);
  await page.mouse.wheel(0, 950);
  await page.waitForFunction(() => !document.querySelector("#playback-upload").hasAttribute("data-active"));
  const pinnedBefore = await page.locator(".route").boundingBox();
  const positions = new Set();
  for (let step = 0; step < 10; step++) {
    await page.mouse.wheel(0, 90);
    await page.waitForTimeout(120);
    positions.add(await page.locator(".marker").evaluate(marker => `${marker.getAttribute("cx")},${marker.getAttribute("cy")}`));
  }
  const pinnedAfter = await page.locator(".route").boundingBox();
  assert.ok(Math.abs(pinnedAfter.y - pinnedBefore.y) < 2, "Route map remains pinned as text scrolls");
  assert.ok(positions.size >= 3, "The marker travels continuously between stops");
  await page.screenshot({ path: path.join(output, "scroll-desktop.png") });
  await page.mouse.wheel(0, -2400);
  await page.waitForFunction(() => document.querySelector("#playback-upload").hasAttribute("data-active"));
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.locator('.network .station[href="#playback-select"]').click();
  await settleStop("playback-select");
  const controlsBox = await page.locator(".readout-controls").boundingBox();
  assert.ok(controlsBox.y + controlsBox.height <= 700, "Short desktop keeps stop controls inside the viewport");
  await page.goto(`${url}/support#color`, { waitUntil: "networkidle" });
  await settleStop("color-contract");
  await page.setViewportSize({ width: 1440, height: 1000 });
  pass("native scrolling advances/reverses stops; map stays pinned with continuous travel, reachable controls and legacy anchors");

  // Station figures: every stop draws one, controls redraw it, and the device
  // check uses only local capability APIs.
  assert.equal(await page.locator(".fig[data-ready]").count(), 12, "Every stop has a prepared figure");
  for (const key of ["p1", "c6", "c4", "p6"]) {
    await page.locator(`.fig[data-fig="${key}"] .fig-plate`).scrollIntoViewIfNeeded();
    await page.waitForFunction(key => document.querySelector(`.fig[data-fig="${key}"] .fig-state`).textContent.trim().length > 0, key);
  }
  const peak = page.locator("#peak-range");
  await peak.scrollIntoViewIfNeeded();
  await peak.focus();
  await peak.evaluate(input => { input.value = "400"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForFunction(() => document.querySelector('output[for="peak-range"]').textContent === "400 cd/m²");
  const gammaState = await page.locator('.fig[data-fig="c4"] .fig-state').textContent();
  assert.ok(gammaState.includes("1.03") || gammaState.startsWith("PQ"), "HLG system gamma follows the display peak");
  await page.locator('.fig[data-fig="p6"] [value="both"]').click();
  assert.equal(await page.locator('.fig[data-fig="p6"] [value="both"]').getAttribute("aria-pressed"), "true");
  const volume = page.locator('.fig[data-fig="c6"] canvas');
  await volume.scrollIntoViewIfNeeded();
  await volume.focus();
  await page.keyboard.press("ArrowRight");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const device = page.locator('.fig[data-fig="p4"]');
  await device.locator("canvas").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-fig="p4"] .fig-state').textContent === "第一个通过的候选即为结果");
  const requestsBeforeProbe = requests.length;
  await device.getByRole("button", { name: "用这台设备试一下" }).click();
  const results = device.locator(".fig-results");
  await results.waitFor({ timeout: 8000 });
  assert.equal(await results.locator("dt").filter({ hasText: /^(Dolby Vision|HDR10|HLG)/ }).count(), 3);
  assert.match(await results.innerText(), /示例查询模式/);
  assert.doesNotMatch(await results.innerText(), /自动选择|已验证 SDR/);
  assert.equal(await device.locator(".fig-state").textContent(), "第一个通过的候选即为结果");
  assert.equal(requests.length, requestsBeforeProbe, "The device check makes no network requests");
  await page.screenshot({ path: path.join(output, "figure-device-check.png") });
  pass("12 station figures, controls, keyboard rotation and example-only device results");

  const range = page.locator('.fig[data-fig="c3"]');
  await range.locator("canvas").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-fig="c3"] .fig-state').textContent.length > 0);
  const [correct, misread] = await range.evaluate(figure => {
    // Observe the two curves painted by the real control without changing the plot.
    const ctx = figure.querySelector("canvas").getContext("2d");
    const { moveTo, lineTo, stroke } = ctx;
    const curves = [];
    let points = [];
    ctx.moveTo = function (x, y) { points = [[x, y]]; moveTo.call(this, x, y); };
    ctx.lineTo = function (x, y) { points.push([x, y]); lineTo.call(this, x, y); };
    ctx.stroke = function () {
      if (points.length > 2) curves.push(points);
      points = [];
      stroke.call(this);
    };
    try { figure.querySelector('[value="c"]').click(); }
    finally { delete ctx.moveTo; delete ctx.lineTo; delete ctx.stroke; }
    return curves;
  });
  assert.deepEqual(correct[0], misread[0], "Both curves start at the same full-range black code");
  assert.deepEqual(correct.at(-1), misread.at(-1), "Both curves end at the same full-range white code");
  assert.ok(correct[1][1] < correct[0][1], "The correct curve retains near-black differences");
  assert.equal(misread[1][1], misread[0][1], "Misreading as limited clips near black");
  await range.screenshot({ path: path.join(output, "figure-full-range.png") });

  const digest = page.locator('.fig[data-fig="p2"] canvas');
  await digest.scrollIntoViewIfNeeded();
  await digest.evaluate(canvas => {
    const ctx = canvas.getContext("2d"), fillText = ctx.fillText;
    ctx.fillText = function (value, x, y) {
      if (/^SHA-256 [0-9a-f]+…[0-9a-f]+$|^[0-9a-f]{32}$/.test(value)) {
        const bounds = canvas.getBoundingClientRect(), metrics = this.measureText(value);
        canvas.dataset.digestFits = String(canvas.dataset.digestFits !== "false" &&
          x + metrics.actualBoundingBoxRight <= bounds.width && y + metrics.actualBoundingBoxDescent <= bounds.height);
      }
      fillText.call(this, value, x, y);
    };
  });
  try {
    // Cover stacked figures above the navigation's separate 420px breakpoint too.
    for (const width of [600, 540, 500, 421, 420, 320]) {
      await digest.evaluate(canvas => delete canvas.dataset.digestFits);
      await page.setViewportSize({ width, height: 1000 });
      await digest.scrollIntoViewIfNeeded();
      await page.waitForSelector('[data-fig="p2"] canvas[data-digest-fits]');
      assert.equal(await digest.getAttribute("data-digest-fits"), "true", `The example digest fits the canvas at ${width}px`);
      await digest.screenshot({ path: path.join(output, `figure-digest-${width}.png`) });
    }
  } finally {
    await digest.evaluate(canvas => { delete canvas.getContext("2d").fillText; delete canvas.dataset.digestFits; });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  pass("full-range comparison uses the right reference and the example digest fits narrow canvases");

  await page.locator("summary").filter({ hasText: "Dolby Vision" }).first().focus();
  await page.keyboard.press("Enter");
  assert.ok(await page.locator("details[open]").filter({ hasText: "Profile 7" }).isVisible());
  const entries = await page.evaluate(() => history.length);
  await page.locator('.contents a[href="#metadata"]').click();
  assert.ok(page.url().endsWith("#metadata"));
  await page.waitForFunction(() => {
    const section = document.getElementById("metadata");
    return Math.abs(section.getBoundingClientRect().top - parseFloat(getComputedStyle(section).scrollMarginTop)) < 4;
  });
  await page.locator('.metadata-list a[href="#color-samples"]').click();
  await settleStop("color-samples");
  await page.locator(".back-top").click();
  assert.ok(page.url().endsWith("#main"));
  assert.equal(await page.evaluate(() => history.length), entries, "In-page anchors replace the entry, so Back leaves in one step");
  pass("keyboard disclosures, section anchors and station references");

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${url}/support`, { waitUntil: "networkidle" });
    await page.locator('.network .station[href="#color-sdr"]').click();
    await settleStop("color-sdr");
    const stageBox = await page.locator("#color-sdr").boundingBox();
    const stripBox = await page.locator(".readout").boundingBox();
    assert.ok(stripBox.height < 844 * .2, "Pinned route strip leaves the reading space");
    assert.ok(stageBox.y >= stripBox.y + stripBox.height - 2, "Stop is not hidden under the pinned strip");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Only the breadcrumb bar stays pinned; the section row scrolled away with the intro.
    const bar = await page.locator(".site-bar").boundingBox();
    assert.ok(Math.abs(bar.y) < 1 && bar.height <= 57, "Breadcrumb bar pinned at the top");
    const sections = await page.locator(".site-nav").boundingBox();
    assert.ok(sections.y + sections.height <= 0, "Section row scrolls away while reading");
    assert.equal(await page.locator(".site-nav").evaluate(nav => nav.scrollWidth <= nav.clientWidth), true, "All five sections fit without scrolling");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await page.screenshot({ path: path.join(output, `mobile-${width}.png`) });
    await page.getByRole("button", { name: "下一站" }).click();
    await settleStop("playback-select");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".trail").evaluate(trail => trail.style.opacity), "0", "Reduced motion moves the marker only between stops");
    assert.equal(await page.locator(".stage:visible").count(), 12);
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(await page.locator(".route").evaluate(el => getComputedStyle(el).display), "contents", "Short landscape uses the strip layout");
  assert.equal(await page.locator(".readout").evaluate(el => getComputedStyle(el).position), "sticky");
  pass("390px/320px layouts, unobscured anchors, live reduced-motion and short-landscape strip");

  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const readable = await noJs.newPage();
  await readable.goto(`${url}/support`);
  assert.equal(await readable.locator(".stage:visible").count(), 12);
  assert.equal(await readable.locator(".readout").isVisible(), false);
  assert.ok(await readable.locator(".network").isVisible());
  assert.equal(await readable.locator(".fig:visible").count(), 0, "Figures need JavaScript and stay out of the no-JS reading");
  await readable.locator("summary").filter({ hasText: "HLG" }).click();
  assert.ok(await readable.locator("details[open]").filter({ hasText: "arib-std-b67" }).isVisible());
  await noJs.close();
  assert.equal(backendRequests, 0);
  pass("JavaScript-disabled reading, static route map and native disclosure without backend access");

  offline = false;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${url}/`, { waitUntil: "networkidle" });
  const homeLink = page.locator('.collection-links a[href="/support"]');
  assert.equal(await homeLink.evaluate(link => link.previousElementSibling.getAttribute("href")), "/about");
  await page.screenshot({ path: path.join(output, "home-entry.png"), fullPage: true });
  const navigation = page.waitForRequest(request => request.url() === `${url}/support` && request.isNavigationRequest());
  await homeLink.click();
  await navigation;
  await page.waitForURL(`${url}/support`);
  assert.equal(await page.locator(".identity").textContent(), "播放与色彩支持");
  // Home is the breadcrumb's first step, so no separate back link appears; the
  // breadcrumb itself steps back rather than stacking a new home entry.
  assert.equal(await page.locator(".site-header .back").isHidden(), true);
  const fromHome = await page.evaluate(() => history.length);
  await page.locator(".crumbs a").click();
  await page.waitForURL(`${url}/`, { waitUntil: "commit" });
  assert.equal(await page.evaluate(() => history.length), fromHome);
  pass("home Support directly below Info opens a standalone document, and the breadcrumb steps back");

  for (const cms of [false, true]) {
    cmsAbout = cms;
    await page.goto(`${url}/about`, { waitUntil: "networkidle" });
    if (cms) assert.equal(await page.locator("h1").textContent(), "测试关于页");
    // The entry sits beside the title, bottoms aligned, not between title and cover.
    const title = await page.locator(".about-header h1").boundingBox();
    const entry = await page.locator(".about-support-link").boundingBox();
    assert.ok(entry.x >= title.x + title.width, "Support entry sits right of the title");
    assert.ok(Math.abs(entry.y + entry.height - (title.y + title.height)) < 2, "Support entry bottom meets the title's");
    await page.locator('a[href="/support"]').click();
    await page.waitForURL(`${url}/support`);
    assert.equal(await page.locator(".identity").textContent(), "播放与色彩支持");
    // Either the named back link or the section link to the same page steps back.
    const back = page.getByRole("link", { name: "返回关于", exact: true });
    assert.equal(await back.isVisible(), true);
    const fromAbout = await page.evaluate(() => history.length);
    await (cms ? page.getByRole("link", { name: "关于", exact: true }) : back).click();
    await page.waitForURL(`${url}/about`, { waitUntil: "commit" });
    assert.equal(await page.evaluate(() => history.length), fromAbout, "Returning steps back instead of stacking entries");
  }
  pass("local and CMS About entries and return navigation");
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
}

main().catch(async error => {
  report.failure = error.stack;
  console.error(error);
  if (page) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await fsp.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  for (const child of children.toReversed()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const stopped = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await stopped;
    clearTimeout(timer);
  }
  backend.closeAllConnections();
  backend.close();
});
