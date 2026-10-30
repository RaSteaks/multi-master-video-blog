const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { webkit, firefox } = require("playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  const engine = process.env.PHASE6_BROWSER === "firefox" ? firefox : webkit;
  const fixture = await startFixture({ name: `phase6-${engine.name()}`, cmsPort: 18058, apiPort: 18063, webPort: 13003 });
  const report = { browser: `headless ${engine.name()}`, checks: [], errors: [], passed: false };
  const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };
  let browser;
  let page;
  try {
    const media = path.join(fixture.temp, "playback");
    await fs.mkdir(media);
    execFileSync(process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24", "-t", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24", "-hls_time", "1", "-hls_list_size", "0", path.join(media, "master.m3u8")]);
    const masters = [1, 2].map(id => ({ id, project_id: 50, label: `SDR ${id}`, type: "sdr", verification_status: "ready", is_default: id === 1, sort_order: id,
      hls_url: `/media/phase6/master.m3u8?master=${id}`, resolution_width: 320, resolution_height: 180, codec: "H.264 / AVC", hls_video_range: "SDR", status: "published" }));
    fixture.collections.video_projects.push({ id: 50, title: "观看体验验收", slug: "phase6-video", published: true, description: "母版切换与时间点链接。", masters });
    await fetch(`${fixture.url}/videos/phase6-video`);
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/media/phase6/**", async route => {
      const file = path.basename(new URL(route.request().url()).pathname);
      await route.fulfill({ path: path.join(media, file), contentType: file.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" });
    });
    page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(`${fixture.url}/posts/fixture-post`, { waitUntil: "networkidle" });
    const tools = page.getByRole("button", { name: "页面工具", exact: true });
    await tools.click();
    assert.deepEqual(await page.locator(".create-menu .action-menu-item").allTextContents(), ["本页目录", "复制本页链接"]);
    assert.equal(await page.locator(".author-menu").count(), 0);
    await page.waitForFunction(() => getComputedStyle(document.querySelectorAll(".page-tools-swatches rect")[1]).fill === "rgb(226, 232, 238)");
    const fill = await page.locator(".page-tools-swatches rect").nth(1).evaluate(element => getComputedStyle(element).fill);
    assert.equal(fill, "rgb(226, 232, 238)");
    await page.keyboard.press("Escape");
    await page.evaluate(() => scrollTo({ top: innerHeight + 50, behavior: "instant" }));
    await tools.click();
    await page.getByRole("button", { name: "回到顶部", exact: true }).waitFor();
    assert.equal(await page.locator(".liquid-bg").first().getAttribute("data-liquid-speed"), "0.35");
    const blur = await page.locator(".site-header").evaluate(element => getComputedStyle(element).getPropertyValue("backdrop-filter"));
    assert.ok(blur.includes("blur(24px)"));
    await page.screenshot({ path: path.join(fixture.output, "article-tools.png") });
    pass("guest page tools, clockwise tones, scroll threshold, detail speed and header glass");

    for (const next of ["/albums", "https://example.com", "//example.com"]) {
      await page.goto(`${fixture.url}/studio?next=${encodeURIComponent(next)}`, { waitUntil: "networkidle" });
      assert.ok((await page.locator('meta[name="robots"]').getAttribute("content")).includes("noindex"));
      const dialog = page.getByRole("dialog", { name: "作者登录", exact: true });
      await dialog.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
      await dialog.getByRole("button", { name: "登录", exact: true }).click();
      await page.waitForURL(`${fixture.url}${next === "/albums" ? next : "/"}`);
      await page.locator(next === "/albums" ? "main" : ".orbital-home").waitFor();
      await page.waitForLoadState("networkidle");
    }
    await context.route("**/api/author/session", route => route.abort());
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "工具", exact: true }).waitFor();
    await context.unroute("**/api/author/session");
    await page.reload({ waitUntil: "networkidle" });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.locator(".author-menu .action-menu-panel").evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    const authorBox = await page.locator(".author-menu .action-menu-panel").boundingBox();
    assert.ok(authorBox.x >= 0 && authorBox.x + authorBox.width <= 360);
    await page.screenshot({ path: path.join(fixture.output, "author-home-360.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    const html = await (await context.request.get(`${fixture.url}/`)).text();
    assert.equal(/class="author-menu/.test(html), false);
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("button", { name: "退出并忘记此设备", exact: true }).click();
    await page.locator(".author-menu").waitFor({ state: "detached" });
    assert.equal((await context.cookies()).some(cookie => cookie.name === "author_device"), false);
    await page.goto(`${fixture.url}/albums/fixture-album`, { waitUntil: "networkidle" });
    assert.equal(await page.getByRole("button", { name: "管理此相簿", exact: true }).count(), 0);
    pass("studio login/local redirect, external redirects rejected, server HTML excludes author controls, forget-device and guest management");

    const project = id => ({ id, title: id === 1 ? "一个很长的网站项目名称，用于确认窄屏下单行截断不会挤破现有布局" : `项目 ${id}`, description: "验收", url: "https://example.com/", preview_url: null, preview_enabled: false, open_mode: id === 1 ? "iframe" : "external", cover_image: null, published: true, sort_order: id });
    for (const count of [0, 1, 3]) {
      fixture.collections.external_projects = Array.from({ length: count }, (_, index) => project(index + 1));
      for (const width of [1440, 1100, 900, 700, 390, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${fixture.url}/`, { waitUntil: "networkidle" });
        assert.equal(await page.locator(".home-action-row .orbit-upload").count(), 3);
        assert.equal(await page.locator(".orbit-upload").filter({ hasText: "进入实验室" }).count(), 3 - count);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify({ count, width, overflow: await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth + 1).map(el => ({ class: el.className, width: el.getBoundingClientRect().width })).slice(0, 8)) }));
        if (count) assert.equal(await page.locator(".orbit-upload").first().getAttribute("href"), "/project#project-1");
        if (count === 3) assert.equal(await page.locator(".orbit-upload").nth(1).getAttribute("rel"), "noopener noreferrer");
        if (count === 3) await page.screenshot({ path: path.join(fixture.output, `home-${width}.png`) });
      }
    }
    await page.locator(".orbit-upload").first().click();
    await page.waitForURL(`${fixture.url}/project#project-1`);
    await page.locator("#project-1").waitFor();
    for (const collection of ["external_projects", "posts", "video_projects", "albums"]) fixture.unavailableCollections.add(collection);
    await page.goto(`${fixture.url}/`, { waitUntil: "networkidle" });
    assert.equal(await page.locator(".orbit-upload").filter({ hasText: "进入实验室" }).count(), 3);
    fixture.unavailableCollections.clear();
    pass("home 0/1/3 projects at all six widths, anchors/external semantics and CMS outage fallback");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${fixture.url}/videos/phase6-video?t=4`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => { const video = document.querySelector("video"); return video && video.readyState >= 2 && Math.abs(video.currentTime - 4) < 0.5; }, null, { timeout: 30000 });
    assert.equal(await page.locator(".master-add").count(), 0);
    const before = await page.locator(".player-frame").boundingBox();
    await page.evaluate(async () => { const video = document.querySelector("video"); video.muted = true; video.loop = true; await video.play(); });
    await page.waitForFunction(() => document.documentElement.dataset.watching === "idle");
    assert.deepEqual(await page.locator(".player-frame").boundingBox(), before);
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".video-title")).opacity === "0");
    await page.mouse.move(300, 200);
    await page.waitForFunction(() => document.documentElement.dataset.watching === "active");
    await page.locator(".master-button").first().focus();
    await page.waitForTimeout(2800);
    assert.equal(await page.locator("html").getAttribute("data-watching"), "active");
    await page.keyboard.press("f");
    await page.waitForFunction(() => document.documentElement.dataset.watching === "fullscreen");
    assert.equal(await page.locator(".liquid-bg").first().getAttribute("data-liquid-speed"), "0");
    await page.locator(".master-button").nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll(".master-button")[1]?.getAttribute("aria-pressed") === "true");
    await page.waitForFunction(() => document.querySelector(".player-frame").dataset.state !== "loading" && document.querySelector("video").readyState >= 2);
    assert.equal(await page.locator(".master-button").nth(1).getAttribute("aria-pressed"), "true");
    assert.ok(await page.getByRole("button", { name: "退出全屏", exact: true }).evaluate(element => element.getBoundingClientRect().bottom <= innerHeight));
    await page.screenshot({ path: path.join(fixture.output, "whole-player-fullscreen.png") });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.documentElement.dataset.watching !== "fullscreen");
    assert.equal(await page.locator(".liquid-bg").first().getAttribute("data-liquid-speed"), "0.35");
    await page.evaluate(() => document.querySelector("video").pause());
    await page.waitForFunction(() => !document.documentElement.dataset.watching);
    await page.locator("video").dblclick();
    await page.waitForFunction(() => document.documentElement.dataset.watching === "fullscreen");
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.watching !== "fullscreen");
    pass("real HLS timestamp seek, idle layout stability/focus recovery, F/double-click fullscreen and master switching");

    const stopped = await browser.newContext();
    await stopped.addInitScript(() => localStorage.setItem("mm-liquid-background-v1", JSON.stringify({ version: 1, speed: 0, color: { kind: "gray" }, slots: [] })));
    const still = await stopped.newPage();
    await still.goto(`${fixture.url}/posts/fixture-post`, { waitUntil: "networkidle" });
    assert.equal(await still.locator(".liquid-bg").first().getAttribute("data-liquid-speed"), "0");
    assert.equal(await still.locator(".blob").first().evaluate(element => getComputedStyle(element).animationPlayState), "paused");
    assert.equal(await still.evaluate(() => JSON.parse(localStorage.getItem("mm-liquid-background-v1")).speed), 0);
    await stopped.close();
    pass("saved zero speed stays paused in the renderer and CSS fallback without rewriting preferences");

    // Fresh mobile context exercises page immersion and coarse-pointer orientation,
    // without claiming to certify a physical phone's native fullscreen implementation.
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: engine === webkit,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" });
    await mobile.route("**/media/phase6/**", async route => {
      const file = path.basename(new URL(route.request().url()).pathname);
      await route.fulfill({ path: path.join(media, file), contentType: file.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" });
    });
    const phone = await mobile.newPage();
    await phone.goto(`${fixture.url}/videos/phase6-video`, { waitUntil: "networkidle" });
    await phone.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    await phone.evaluate(async () => { const video = document.querySelector("video"); video.muted = true; video.loop = true; await video.play(); });
    assert.equal(await phone.locator(".player-frame").evaluate(element => getComputedStyle(element).position), "sticky");
    await phone.setViewportSize({ width: 844, height: 390 });
    await phone.locator(".player-immersive").waitFor();
    await phone.waitForFunction(() => document.documentElement.dataset.watching === "fullscreen" && getComputedStyle(document.querySelector(".site-header")).opacity === "0");
    assert.ok(await phone.getByRole("button", { name: "退出全屏", exact: true }).evaluate(element => element.getBoundingClientRect().bottom <= innerHeight));
    await phone.screenshot({ path: path.join(fixture.output, "mobile-landscape.png") });
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.locator(".player-immersive").waitFor({ state: "detached" });
    assert.notEqual(await phone.evaluate(() => document.body.style.overflow), "hidden");
    await phone.screenshot({ path: path.join(fixture.output, "mobile-portrait.png") });
    await mobile.close();
    pass("touch portrait sticky frame, landscape auto-immersion and reversible scroll lock");
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    await page?.screenshot({ path: path.join(fixture.output, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await fs.writeFile(path.join(fixture.output, "report.json"), JSON.stringify(report, null, 2));
    await browser?.close(); await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
