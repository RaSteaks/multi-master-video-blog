const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
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
    assert.equal(await page.evaluate(() => typeof document.startViewTransition), "function");
    await Promise.all([
      page.getByRole("navigation", { name: "主要导航" }).getByRole("link", { name: "文章", exact: true }).click(),
      new Promise(resolve => setTimeout(() => { release(); resolve(); }, 650)),
    ]);
    await page.waitForURL(`${fixture.url}/posts`);
    await page.waitForFunction(() => !document.querySelector("[data-route-loading]"));
    await page.waitForFunction(() => document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "")), null, { timeout: 5000 });
    assert.ok(delayedRequests > 0);
    const fallback = page.locator(".route-wipe-line-fallback");
    assert.equal(await fallback.getAttribute("data-wipe-direction"), "forward");
    await page.waitForFunction(() => {
      const box = document.querySelector(".route-wipe-line-fallback").getBoundingClientRect();
      return box.x + box.width / 2 > innerWidth * 0.3;
    });
    await page.screenshot({ path: path.join(fixture.output, "slow-navigation-wipe.png") });
    pass("production RSC response delayed beyond the native snapshot budget still shows a divider when content arrives");
    await page.waitForFunction(() => !document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "")));
    assert.equal(await fallback.getAttribute("data-wipe-direction"), null);
    await page.unroute("**/*");
    await page.waitForLoadState("networkidle");
    const nav = page.getByRole("navigation", { name: "主要导航" });
    await nav.getByRole("link", { name: "关于", exact: true }).click();
    await page.waitForURL(`${fixture.url}/about`);
    await page.locator(".route-wipe-line:not(.route-wipe-line-fallback)").waitFor({ state: "attached" });
    assert.equal(await page.locator("html").getAttribute("data-vt-direction"), "forward");
    await page.waitForFunction(() => !document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "")));
    pass("cached production navigation retains its native snapshot wipe");

    await nav.getByRole("link", { name: "文章", exact: true }).click();
    await page.waitForURL(`${fixture.url}/posts`);
    await page.waitForFunction(() => document.getAnimations().some(animation => animation.animationName === "vt-wipe-line-back"));
    await page.goBack();
    await page.waitForURL(`${fixture.url}/about`);
    await page.waitForFunction(() => !document.querySelector("html[data-vt-direction], .route-wipe-line[data-wipe-direction], .route-wipe-line:not(.route-wipe-line-fallback)"));
    assert.equal(await page.evaluate(() => document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || ""))), false);
    pass("reverse navigation uses the mirrored divider; browser Back cancels it and clears snapshot state");

    // Trigger a real native snapshot rejection, without replacing the browser API.
    await rejectSnapshots(page);
    await nav.getByRole("link", { name: "文章", exact: true }).click();
    await page.waitForURL(`${fixture.url}/posts`);
    await page.waitForFunction(() => document.querySelector(".route-wipe-line-fallback")?.getAttribute("data-wipe-direction") === "back");
    await page.evaluate(() => document.querySelectorAll(".duplicate-snapshot-fixture").forEach(node => node.remove()));
    await page.waitForFunction(() => {
      const box = document.querySelector(".route-wipe-line-fallback").getBoundingClientRect();
      return box.x + box.width / 2 < innerWidth * 0.7;
    });
    await page.screenshot({ path: path.join(fixture.output, "rejected-snapshot-wipe.png") });
    // Navigate again while the fallback still plays: old completion must not
    // clear the new navigation's line, direction or loading ownership.
    await nav.getByRole("link", { name: "实验室", exact: true }).click();
    await page.waitForURL(`${fixture.url}/project`);
    await nav.getByRole("link", { name: "视频", exact: true }).click();
    await page.waitForURL(`${fixture.url}/videos`);
    await page.waitForFunction(() => document.getAnimations().some(animation => animation.animationName === "vt-wipe-line-back"));
    await page.waitForFunction(() => !document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || "")));
    assert.equal(await fallback.getAttribute("data-wipe-direction"), null);
    assert.equal(await page.locator("html").getAttribute("data-vt-direction"), null);
    pass("native snapshot rejection falls back to a divider; rapid navigation cancels old effects without losing the final wipe");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await nav.getByRole("link", { name: "关于", exact: true }).click();
    await page.waitForURL(`${fixture.url}/about`);
    assert.equal(await page.evaluate(() => document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || ""))), false);
    assert.equal(await fallback.getAttribute("data-wipe-direction"), null);
    pass("reduced motion remains instant with no divider animation");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await rejectSnapshots(page);
    await nav.getByRole("link", { name: "文章", exact: true }).click();
    await page.waitForURL(`${fixture.url}/posts`);
    await page.waitForFunction(() => document.querySelector(".route-wipe-line-fallback")?.getAttribute("data-wipe-direction") === "back");
    const lineTop = await fallback.evaluate(node => node.getBoundingClientRect().top);
    const headerBottom = await page.locator(".site-header").evaluate(node => node.getBoundingClientRect().bottom);
    assert.ok(Math.abs(lineTop - headerBottom) < 1);
    await page.waitForFunction(() => {
      const box = document.querySelector(".route-wipe-line-fallback").getBoundingClientRect();
      return box.x + box.width / 2 < innerWidth * 0.7;
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(fixture.output, "mobile-wipe.png") });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => !document.querySelector(".route-wipe-line-fallback[data-wipe-direction]"));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await page.evaluate(() => document.getAnimations().some(animation => /^vt-wipe-line/.test(animation.animationName || ""))), false);
    pass("narrow viewport divider starts below the header; enabling reduced motion cancels it without replay");
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
