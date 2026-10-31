const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit, firefox } = require("playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  const engine = process.env.TRAY_BROWSER === "firefox" ? firefox : webkit;
  const fixture = await startFixture({ name: `author-tray-${engine.name()}`, cmsPort: 18058, apiPort: 18063, webPort: 13003 });
  let browser;
  let page;
  const report = { browser: `headless ${engine.name()}`, checks: [], errors: [], errorDetails: [], passed: false };
  const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  try {
    await fetch(`${fixture.url}/about`);
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("pageerror", error => { report.errors.push(error.message); report.errorDetails.push({ message: error.message, stack: error.stack, after: report.checks.at(-1) }); });
    const tray = page.getByRole("group", { name: "快速创作托盘", exact: true });
    async function hold(x = 500, y = 350) {
      await page.mouse.move(x, y);
      await page.keyboard.down("Tab");
      await tray.waitFor();
      const box = await tray.boundingBox();
      assert.ok(Math.abs(box.x + box.width / 2 - x) < 1 && Math.abs(box.y + box.height / 2 - y) < 1, "The actual cursor must be at the disk center when it opens.");
      assert.ok(Math.abs(box.width - box.height) < 1);
    }
    async function pointAt(name) {
      const box = await tray.getByRole("link", { name, exact: true }).locator(".author-tray-action-copy").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
      assert.equal(await tray.getByRole("link", { name, exact: true }).getAttribute("data-selected"), "true");
    }
    async function blurFocus() { await page.evaluate(() => document.activeElement?.blur()); }

    await page.goto(`${fixture.url}/posts/fixture-post`, { waitUntil: "networkidle" });
    await page.keyboard.down("Tab"); await page.waitForTimeout(300);
    assert.equal(await tray.count(), 0);
    await page.keyboard.up("Tab");
    await context.addCookies([{ name: "author_device", value: "1", url: fixture.url }]);
    await page.reload({ waitUntil: "networkidle" });
    await page.keyboard.down("Tab"); await page.waitForTimeout(300);
    assert.equal(await tray.count(), 0);
    const expiredHint = page.getByText("登录已过期，点钢笔图标重新登录", { exact: true });
    await expiredHint.waitFor();
    await page.keyboard.up("Tab");
    assert.equal(await expiredHint.count(), 1); // Still readable after release.
    await expiredHint.waitFor({ state: "detached" });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Tab"); await page.waitForTimeout(100);
    assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "BODY");
    assert.equal(await expiredHint.count(), 0);
    await page.evaluate(() => document.activeElement?.blur());
    pass("visitors are untouched; an expired author device explains a held Tab and keeps short Tab focus");

    const login = await context.request.post(`${fixture.url}/api/author/session`, { headers: { Origin: fixture.url }, data: { token: fixture.token } });
    assert.equal(login.status(), 200);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.locator(".author-menu").getByRole("link", { name: "上传视频", exact: true }).waitFor();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(240);
    assert.equal(await tray.count(), 0);
    await page.getByRole("button", { name: "工具", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "工具", exact: true }).getAttribute("aria-expanded"), "false");
    await page.locator(".brand").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".brand")), false);
    await page.waitForTimeout(240);
    assert.equal(await tray.count(), 0);
    await page.keyboard.down("Shift"); await page.keyboard.down("Tab"); await page.waitForTimeout(240);
    assert.equal(await tray.count(), 0);
    await page.keyboard.up("Tab"); await page.keyboard.up("Shift");
    pass("short Tab advances focus; Shift+Tab and ordinary-menu Tab stay native");


    await blurFocus();
    await hold();
    assert.equal(await tray.locator('[data-selected="true"]').count(), 0);
    assert.equal(await tray.getByRole("link").count(), 6);
    await page.keyboard.down("Tab");
    assert.ok(await page.evaluate(() => document.activeElement === document.querySelector(".author-tray")));
    await page.keyboard.up("Tab");
    await tray.waitFor({ state: "detached" });
    assert.ok(page.url().endsWith("/posts/fixture-post"));
    await blurFocus(); await hold(); await pointAt("上传视频");
    await page.mouse.down();
    await pointAt("写文章");
    await page.screenshot({ path: path.join(fixture.output, "tray-selected.png") });
    await page.mouse.up();
    await tray.getByRole("link", { name: "写文章", exact: true }).locator(".author-tray-action-copy").click();
    assert.ok(page.url().endsWith("/posts/fixture-post"), "Mouse release must not bypass Tab confirmation.");
    await page.keyboard.press("Escape"); await page.keyboard.up("Tab");
    await tray.waitFor({ state: "detached" });
    assert.ok(page.url().endsWith("/posts/fixture-post"));
    pass("circular tray opens at the cursor center; drag highlights sectors; no movement/Escape cancel");

    await blurFocus(); await hold();
    const disk = await tray.boundingBox();
    // Select on the outer ring away from the icon/label, then return to the
    // central dead zone. Both are real CSS-clipped HTML-link hit tests.
    await page.mouse.move(500, disk.y + 10, { steps: 6 });
    assert.equal(await tray.getByRole("link", { name: "写文章", exact: true }).getAttribute("data-selected"), "true");
    await page.mouse.move(500, 350, { steps: 6 });
    assert.equal(await tray.locator('[data-selected="true"]').count(), 0);
    await page.keyboard.up("Tab"); await tray.waitFor({ state: "detached" });
    assert.ok(page.url().endsWith("/posts/fixture-post"));
    pass("sectors select across the whole ring and returning to the center cancels");

    await blurFocus(); await hold(); await pointAt("上传视频");
    await page.mouse.move(30, 500);
    assert.equal(await tray.locator('[data-selected="true"]').count(), 0);
    await page.keyboard.up("Tab"); await tray.waitFor({ state: "detached" });
    assert.ok(page.url().endsWith("/posts/fixture-post"));
    await blurFocus(); await hold(); await pointAt("上传视频");
    await page.mouse.move(-20, -20);
    await page.keyboard.up("Tab"); await tray.waitFor({ state: "detached" });
    assert.ok(page.url().endsWith("/posts/fixture-post"));
    await blurFocus(); await hold(); await pointAt("上传视频");
    await page.keyboard.up("Tab");
    await page.waitForURL(`${fixture.url}/upload`);
    await page.locator("form.upload-form").waitFor(); await page.waitForLoadState("networkidle");
    assert.equal(await tray.count(), 0);
    const title = page.getByLabel("标题", { exact: true });
    await title.focus(); await page.keyboard.down("Tab"); await page.waitForTimeout(300);
    assert.equal(await tray.count(), 0);
    await page.keyboard.up("Tab");
    pass("moving outside cancels; releasing Tab follows the selected author link; form Tab is untouched");

    await page.goto(`${fixture.url}/albums/fixture-album`, { waitUntil: "networkidle" });
    await blurFocus(); await hold();
    assert.equal(await tray.getByRole("link", { name: "上传到此相簿", exact: true }).getAttribute("href"), "/albums/fixture-album?action=upload");
    await pointAt("上传到此相簿"); await page.keyboard.up("Tab");
    await page.getByLabel("相簿管理模式", { exact: true }).waitFor();
    // AlbumGallery consumes action=upload with router.replace; let that finish
    // before the test starts an unrelated navigation.
    await page.waitForURL(`${fixture.url}/albums/fixture-album`);
    await page.waitForLoadState("networkidle");
    await page.goto(`${fixture.url}/albums?dialog=create`, { waitUntil: "networkidle" });
    const modal = page.getByRole("dialog", { name: "新建相簿", exact: true });
    await modal.waitFor();
    await page.keyboard.down("Tab"); await page.waitForTimeout(300);
    assert.equal(await tray.count(), 0);
    await page.keyboard.up("Tab");
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    await page.waitForURL(`${fixture.url}/albums`); await page.waitForLoadState("networkidle");
    pass("album-specific actions are shared and open dialogs keep their own keyboard navigation");

    // The immersive player publishes this state even without the element-level
    // fullscreen API (iPhone). Its keyboard ownership must remain exclusive.
    await page.evaluate(() => { document.documentElement.dataset.watching = "fullscreen"; });
    await blurFocus(); await page.keyboard.down("Tab"); await page.waitForTimeout(300);
    assert.equal(await tray.count(), 0);
    await page.keyboard.up("Tab");
    await page.evaluate(() => { delete document.documentElement.dataset.watching; });
    pass("fullscreen viewing state keeps exclusive keyboard ownership");

    await page.goto(`${fixture.url}/write`, { waitUntil: "networkidle" });
    await page.locator("#article-title").fill("托盘未保存文章");
    await page.locator("#article-content").fill("## 未保存正文\n\n应当保留。");
    await page.locator("#article-content").focus();
    await page.keyboard.down("Tab"); await page.waitForTimeout(300);
    assert.equal(await tray.count(), 0);
    await page.keyboard.up("Tab");
    await page.locator(".brand").focus();
    await hold(); await pointAt("上传视频");
    let guarded = false;
    page.once("dialog", async dialog => { assert.equal(dialog.type(), "confirm"); guarded = true; await dialog.dismiss(); });
    await page.keyboard.up("Tab");
    await tray.waitFor({ state: "detached" });
    assert.equal(guarded, true);
    assert.ok(page.url().endsWith("/write"));
    assert.ok((await page.locator("#article-content").inputValue()).includes("应当保留"));
    page.once("dialog", dialog => dialog.accept());
    await page.goto(`${fixture.url}/posts/fixture-post`, { waitUntil: "networkidle" });
    await blurFocus(); await hold(); await pointAt("上传视频");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await tray.waitFor({ state: "detached" }); await page.keyboard.up("Tab");
    assert.ok(page.url().endsWith("/posts/fixture-post"));
    await blurFocus(); await hold();
    await page.setViewportSize({ width: 1100, height: 900 });
    await tray.waitFor({ state: "detached" }); await page.keyboard.up("Tab");
    pass("editor indentation/unsaved-navigation guards remain intact and interrupted holds cancel");

    await page.goto(`${fixture.url}/posts/fixture-post`, { waitUntil: "networkidle" });
    await page.setViewportSize({ width: 390, height: 700 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await blurFocus(); await page.mouse.move(370, 650); await page.keyboard.down("Tab");
    await page.getByText("将鼠标移向页面中央，留出圆盘空间", { exact: true }).waitFor();
    assert.equal(await tray.count(), 0);
    await page.mouse.move(195, 350);
    await tray.waitFor();
    const box = await tray.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 700);
    assert.ok(Math.abs(box.x + box.width / 2 - 195) < 1 && Math.abs(box.y + box.height / 2 - 350) < 1);
    assert.equal(await tray.locator('[data-selected="true"]').count(), 0);
    assert.equal(await tray.evaluate(element => getComputedStyle(element).animationName), "none");
    await page.screenshot({ path: path.join(fixture.output, "tray-edge-reduced.png") });
    await page.keyboard.up("Tab");
    await tray.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 300, height: 270 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await blurFocus(); await page.mouse.move(150, 135); await page.keyboard.down("Tab");
    await page.getByText("窗口空间不足，请放大窗口或使用页头工具", { exact: true }).waitFor();
    assert.equal(await tray.count(), 0);
    await page.keyboard.up("Tab");
    await page.locator(".author-tray-layer").waitFor({ state: "detached" });
    pass("edges wait for inward movement without moving the center; small windows and reduced motion remain usable");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(`${fixture.url}/about`, { waitUntil: "networkidle" });
    await blurFocus(); await hold(); await pointAt("上传视频");
    await page.goBack({ waitUntil: "networkidle" });
    await tray.waitFor({ state: "detached" }); await page.keyboard.up("Tab");
    assert.ok(page.url().endsWith("/posts/fixture-post"));
    pass("navigation cancels the gesture even when both routes share the same action groups");
    await blurFocus(); await hold(); await pointAt("上传视频");
    // Real session revocation/visibility refresh cancels a held gesture.
    const status = await (await context.request.get(`${fixture.url}/api/author/session`)).json();
    await context.request.delete(`${fixture.url}/api/author/session`, { headers: { Origin: fixture.url, "X-Author-CSRF": status.csrf } });
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await tray.waitFor({ state: "detached" }); await page.keyboard.up("Tab");
    assert.ok(page.url().endsWith("/posts/fixture-post"));
    pass("session revocation cancels selection before the held key can navigate");
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    await page?.screenshot({ path: path.join(fixture.output, "failure.png") }).catch(() => {});
    throw error;
  } finally {
    await fs.writeFile(path.join(fixture.output, "report.json"), JSON.stringify(report, null, 2));
    await browser?.close(); await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
