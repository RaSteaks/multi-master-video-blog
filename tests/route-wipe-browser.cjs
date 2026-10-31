const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const { webkit } = require("playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  const fixture = await startFixture({ name: "route-wipe-production", cmsPort: 18061, apiPort: 18066, webPort: 13006, production: true });
  const report = { browser: "headless WebKit", mode: "production", checks: [], errors: [], passed: false };
  let browser, page, release;
  const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  try {
    browser = await webkit.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    const gate = new Promise(resolve => { release = resolve; });
    let delayedRequests = 0;
    await page.route("**/*", async route => {
      const request = route.request();
      if (new URL(request.url()).pathname === "/posts" && request.headers().rsc === "1") {
        delayedRequests++;
        await gate;
      }
      await route.continue();
    });
    await page.goto(`${fixture.url}/videos`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".nav-pill")?.getAttribute("data-ready") === "true");
    // Distinctive fixture pixels expose a premature reveal: the old video page
    // has no card, while the destination article card is magenta. Remove only
    // decorative backgrounds so a moving liquid simulation cannot skew samples.
    const fixtureStyle = await page.addStyleTag({ content: ".liquid-bg,.site-bg{visibility:hidden!important}.content-card,.content-card .media-placeholder{background:#ff00ff!important}" });
    assert.equal(await page.evaluate(() => typeof document.startViewTransition), "function");
    await Promise.all([
      page.getByRole("navigation", { name: "主要导航" }).getByRole("link", { name: "文章", exact: true }).click(),
      new Promise(resolve => setTimeout(() => { release(); resolve(); }, 650)),
    ]);
    await page.waitForURL(`${fixture.url}/posts`);
    await page.waitForFunction(() => !document.querySelector("[data-route-loading]"));
    await page.waitForFunction(() => document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "")), null, { timeout: 5000 });
    assert.ok(delayedRequests > 0);
    await page.waitForFunction(() => document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "") && animation.currentTime > 250));
    const clocks = await page.evaluate(() => document.getAnimations()
      .filter(animation => /^vt-wipe-(reveal|line)/.test(animation.animationName || ""))
      .map(animation => animation.startTime));
    assert.ok(clocks.length >= 2 && clocks.every(time => time === clocks[0]), `Wipe clocks differ: ${clocks}`);
    await pauseWipeAt(page, 0.1);
    const card = await page.locator(".content-card").first().boundingBox();
    const early = await page.screenshot({ path: path.join(fixture.output, "early-wipe.png") });
    const pixel = await sharp(early).extract({ left: Math.round(card.x + card.width / 2), top: Math.round(card.y + 40), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.ok(pixel[0] < 60 && pixel[2] < 60, `Destination card leaked ahead of the divider: ${[...pixel]}`);
    const header = await sharp(early).extract({ left: 80, top: 12, width: 350, height: 40 }).removeAlpha().raw().toBuffer();
    assert.ok(Array.from({ length: header.length / 3 }, (_, index) => header[index * 3] > 160 && header[index * 3 + 1] > 160 && header[index * 3 + 2] > 160).filter(Boolean).length > 20,
      "The header disappeared during the native transition");
    await pauseWipeAt(page, 0.3);
    const middle = await page.screenshot({ path: path.join(fixture.output, "aligned-wipe.png") });
    const row = await sharp(middle).extract({ left: Math.round(card.x + 30), top: Math.round(card.y + 40), width: Math.round(card.width - 40), height: 1 }).removeAlpha().raw().toBuffer();
    const pixels = Array.from({ length: row.length / 3 }, (_, index) => [...row.subarray(index * 3, index * 3 + 3)]);
    const edge = pixels.findLastIndex(([r, g, b]) => r > 220 && g < 30 && b > 220);
    const divider = pixels.findIndex(([r, g, b]) => r > 180 && g > 180 && b > 180);
    assert.ok(edge >= 0 && divider >= 0 && Math.abs(divider - edge) <= 3, `Divider and reveal edge differ: ${divider} vs ${edge}`);
    assert.equal(await page.locator("html").getAttribute("data-vt-direction"), "forward");
    await pauseWipeAt(page, 0.7);
    const revealed = await page.screenshot({ path: path.join(fixture.output, "revealed-wipe.png") });
    const revealedPixel = await sharp(revealed).extract({ left: Math.round(card.x + card.width / 2), top: Math.round(card.y + 40), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.ok(revealedPixel[0] > 220 && revealedPixel[1] < 30 && revealedPixel[2] > 220, `Destination was not revealed behind the divider: ${[...revealedPixel]}`);
    await page.evaluate(() => document.getAnimations().filter(animation => /^vt-wipe/.test(animation.animationName || "")).forEach(animation => animation.play()));
    await page.screenshot({ path: path.join(fixture.output, "slow-navigation-wipe.png") });
    pass("650ms production navigation uses real snapshots: outgoing pixels remain ahead of the divider and destination pixels appear only behind it");
    await page.waitForFunction(() => !document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "")));
    await fixtureStyle.evaluate(node => node.remove());
    await page.unroute("**/*");
    await page.waitForLoadState("networkidle");
    const nav = page.getByRole("navigation", { name: "主要导航" });
    await nav.getByRole("link", { name: "关于", exact: true }).click();
    await page.waitForURL(`${fixture.url}/about`);
    await page.locator(".route-wipe-line").waitFor({ state: "attached" });
    assert.equal(await page.locator("html").getAttribute("data-vt-direction"), "forward");
    await page.waitForFunction(() => document.getAnimations().some(animation => animation.animationName === "vt-wipe-line" && animation.currentTime > 0));
    const pillBox = await page.locator(".nav-pill").boundingBox();
    const activeBox = await nav.getByRole("link", { name: "关于", exact: true }).boundingBox();
    assert.ok(Math.abs(pillBox.x - activeBox.x) < 1 && Math.abs(pillBox.width - activeBox.width) < 1,
      "Header snapshot captured an unfinished navigation highlight");
    await pauseWipeAt(page, 0.45);
    await page.screenshot({ path: path.join(fixture.output, "native-content-wipe.png") });
    await page.evaluate(() => document.getAnimations().filter(animation => /^vt-wipe/.test(animation.animationName || "")).forEach(animation => animation.play()));
    await page.waitForFunction(() => !document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "")));
    pass("cached production navigation retains its native snapshot wipe");

    await nav.getByRole("link", { name: "文章", exact: true }).click();
    await page.waitForURL(`${fixture.url}/posts`);
    await page.waitForFunction(() => document.getAnimations().some(animation => animation.animationName === "vt-wipe-line-back"));
    await page.goBack();
    await page.waitForURL(`${fixture.url}/about`);
    await page.waitForFunction(() => !document.querySelector("html[data-vt-direction], .route-wipe-line"));
    assert.equal(await page.evaluate(() => document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || ""))), false);
    pass("reverse navigation uses the mirrored divider; browser Back cancels it and clears snapshot state");

    // Trigger a real native snapshot rejection, without replacing the browser API.
    await rejectSnapshots(page);
    await nav.getByRole("link", { name: "文章", exact: true }).click();
    await page.waitForURL(`${fixture.url}/posts`);
    await assertDirectSwitch(page);
    await page.evaluate(() => document.querySelectorAll(".duplicate-snapshot-fixture").forEach(node => node.remove()));
    await page.screenshot({ path: path.join(fixture.output, "rejected-snapshot-direct.png") });
    pass("rejected snapshots reveal the page directly with no veil flash or delayed divider");
    // A superseded native transition must not clear the next navigation's line.
    await nav.getByRole("link", { name: "实验室", exact: true }).click();
    await page.waitForURL(`${fixture.url}/project`);
    await nav.getByRole("link", { name: "视频", exact: true }).click();
    await page.waitForURL(`${fixture.url}/videos`);
    await page.waitForFunction(() => document.getAnimations().some(animation => animation.animationName === "vt-wipe-line-back"));
    await page.waitForFunction(() => !document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "")));
    assert.equal(await page.locator(".route-wipe-line").count(), 0);
    assert.equal(await page.locator("html").getAttribute("data-vt-direction"), null);
    pass("rapid navigation cancels old snapshots without losing the final native wipe");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await nav.getByRole("link", { name: "关于", exact: true }).click();
    await page.waitForURL(`${fixture.url}/about`);
    assert.equal(await page.evaluate(() => document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || ""))), false);
    assert.equal(await page.locator(".route-wipe-line").count(), 0);
    pass("reduced motion remains instant with no divider animation");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await nav.getByRole("link", { name: "文章", exact: true }).click();
    await page.waitForURL(`${fixture.url}/posts`);
    await page.locator(".route-wipe-line").waitFor({ state: "attached" });
    const lineTop = await page.locator(".route-wipe-line").evaluate(node => node.getBoundingClientRect().top);
    const headerBottom = await page.locator(".site-header").evaluate(node => node.getBoundingClientRect().bottom);
    assert.ok(Math.abs(lineTop - headerBottom) < 1);
    await pauseWipeAt(page, 0.4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(fixture.output, "mobile-wipe.png") });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => !document.querySelector(".route-wipe-line"));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await page.evaluate(() => document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || ""))), false);
    pass("narrow native wipe aligns below the header; reduced motion cancels it without replay");

    const slowContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await slowContext.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    const slowGate = new Promise(resolve => { release = resolve; });
    await page.route("**/*", async route => {
      if (new URL(route.request().url()).pathname === "/posts" && route.request().headers().rsc === "1") await slowGate;
      await route.continue();
    });
    await page.goto(`${fixture.url}/videos`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector(".nav-pill")?.getAttribute("data-ready") === "true");
    await Promise.all([
      page.getByRole("navigation", { name: "主要导航" }).getByRole("link", { name: "文章", exact: true }).click(),
      new Promise(resolve => setTimeout(() => { release(); resolve(); }, 3500)),
    ]);
    await page.waitForURL(`${fixture.url}/posts`);
    await assertDirectSwitch(page);
    await page.screenshot({ path: path.join(fixture.output, "timeout-direct.png") });
    pass("a response beyond the 3s snapshot budget switches directly without a late line or veil flash");
    await slowContext.close();
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    await page?.screenshot({ path: path.join(fixture.output, "failure.png") }).catch(() => {});
    throw error;
  } finally {
    release?.();
    await fs.writeFile(path.join(fixture.output, "report.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    await fixture.close();
  }
}

async function pauseWipeAt(page, progress) {
  await page.evaluate(progress => {
    for (const animation of document.getAnimations()) {
      if (!/^vt-wipe/.test(animation.animationName || "")) continue;
      animation.pause();
      animation.currentTime = Number(animation.effect.getTiming().duration) * progress;
    }
  }, progress);
}

async function assertDirectSwitch(page) {
  await page.waitForFunction(() => !document.querySelector(".route-wipe-line, [data-route-loading]"));
  const frames = await page.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      samples.push({ veilOpacity: getComputedStyle(document.querySelector(".route-veil")).opacity,
        divider: document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "")) });
    }
    return samples;
  });
  assert.ok(frames.every(frame => frame.veilOpacity === "0" && !frame.divider), JSON.stringify(frames));
}

async function rejectSnapshots(page) {
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) {
      const node = document.createElement("div");
      node.className = "duplicate-snapshot-fixture";
      node.style.cssText = "position:fixed;width:2px;height:2px;view-transition-name:duplicate-fixture";
      document.body.append(node);
    }
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
