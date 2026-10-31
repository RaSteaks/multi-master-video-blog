const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

// Exercise the running local app in fresh headless WebKit contexts, never a personal browser.
const baseUrl = process.env.MOTION_TEST_URL || "http://127.0.0.1:3000";
const output = path.resolve("test-results/motion-ui");
const report = { browser: "headless WebKit", checks: [], pageErrors: [] };
let browser;
let page;

async function openPanel(context) {
  const current = await context.newPage();
  current.on("pageerror", error => report.pageErrors.push(error.message));
  await current.goto(baseUrl);
  await current.getByRole("button", { name: "外观设置", exact: true }).click();
  const panel = current.getByRole("dialog", { name: "外观设置", exact: true });
  await panel.waitFor();
  return { current, panel };
}

function pass(name) {
  report.checks.push(name);
  console.log(name);
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  browser = await webkit.launch({ headless: true,
    ...(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  // Local transitions must work even when the route snapshot API is unavailable.
  await context.addInitScript(() => Object.defineProperty(document, "startViewTransition", { value: undefined, configurable: true }));
  const opened = await openPanel(context);
  page = opened.current;
  const panel = opened.panel;
  await panel.getByRole("tab", { name: "颜色", exact: true }).click();
  assert.equal(await panel.getByRole("tab", { name: "颜色", exact: true }).getAttribute("aria-selected"), "true");
  await panel.getByRole("tab", { name: "背景", exact: true }).press("ArrowRight");
  assert.equal(await panel.getByRole("tab", { name: "颜色", exact: true }).evaluate(el => el === document.activeElement), true);
  await panel.getByRole("tab", { name: "颜色", exact: true }).press("Home");
  assert.equal(await panel.getByRole("tab", { name: "背景", exact: true }).getAttribute("aria-selected"), "true");
  pass("Live Next app: local switching without View Transition, arrow/Home keyboard selection and focus");

  await panel.evaluate(element => {
    const buttons = element.querySelectorAll('.appearance-panel-tabs [role="tab"]');
    for (const i of [1, 0, 1, 0, 1, 0, 1]) buttons[i].click();
  });
  await page.waitForTimeout(340);
  assert.equal(await panel.getByRole("tab", { name: "颜色", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await panel.locator("[data-panel-animating]").count(), 0);
  assert.equal(await panel.locator(".appearance-panel-content").evaluate(el => el.getAnimations({ subtree: true }).length), 0);
  assert.equal(await page.locator("html").evaluate(el => el.classList.contains("vt-panel")), false);
  await panel.getByRole("tab", { name: "HSV 自定义", exact: true }).click();
  await page.waitForTimeout(340);
  assert.equal(await panel.getByRole("tab", { name: "HSV 自定义", exact: true }).getAttribute("aria-selected"), "true");
  await page.screenshot({ path: path.join(output, "appearance-desktop.png"), fullPage: true });
  pass("Rapid selections settle to the latest content; nested tabs work; no stale effects or global transition flags");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await panel.getByRole("tab", { name: "背景", exact: true }).click();
  const properties = await panel.locator(".appearance-panel-content").evaluate(el =>
    el.getAnimations({ subtree: true }).flatMap(animation => animation.effect.getKeyframes().flatMap(frame => Object.keys(frame))));
  assert.equal(properties.includes("transform") || properties.includes("height"), false);
  await page.waitForTimeout(140);
  assert.equal(await panel.locator("[data-panel-animating]").count(), 0);
  pass("Reduced motion uses no content displacement/height animation and cleans up promptly");

  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("tab", { name: "颜色", exact: true }).click();
  await page.waitForTimeout(140);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const box = await panel.boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
  await page.screenshot({ path: path.join(output, "appearance-mobile.png"), fullPage: true });
  await panel.getByRole("button", { name: "关闭外观设置", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "外观设置", exact: true }).evaluate(el => el === document.activeElement), true);
  pass("390px panel stays in viewport, closes and restores focus");
  await context.tracing.stop({ path: path.join(output, "trace.zip") });
  await context.close();

  const fallback = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await fallback.addInitScript(() => { Element.prototype.animate = undefined; });
  const plain = await openPanel(fallback);
  page = plain.current;
  await plain.panel.getByRole("tab", { name: "颜色", exact: true }).click();
  assert.equal(await plain.panel.getByRole("tab", { name: "颜色", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await plain.panel.locator(".appearance-panel-content").evaluate(el => getComputedStyle(el.firstElementChild).opacity), "1");
  pass("Missing Web Animations API leaves the committed content visible and usable");
  await fallback.close();
  assert.deepEqual(report.pageErrors, []);
})().catch(async error => {
  report.error = error.stack || String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser?.close();
});
