const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { startFixture } = require("./helpers/video-upload-fixture.cjs");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// This suite only launches headless WebKit with a fresh browser context.
(async () => {
  const fixture = await startFixture();
  let browser, page;
  const report = { browser: "headless WebKit", checks: [], consoleErrors: [] };
  const pass = message => { report.checks.push(message); console.log(message); };
  try {
    browser = await webkit.launch({ headless: true,
      ...(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, reducedMotion: "reduce" });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.on("pageerror", error => report.consoleErrors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    await page.goto(fixture.url);
    await page.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
    await page.locator('input[type="file"]').first().setInputFiles(fixture.video);
    await page.getByLabel("标题", { exact: true }).fill("Weak network fixture");
    // First chunk travels at 256 Kbps; its ACK is deliberately lost.
    fixture.stats.rate = 32_000; fixture.stats.loseNext = true;
    await page.getByRole("button", { name: "上传视频", exact: true }).click();
    await page.getByRole("button", { name: "暂停上传", exact: true }).waitFor();
    console.log("Uploading first chunk at 256 Kbps with a deliberately lost response");
    for (let i = 0; i < 100 && fixture.stats.patches.length < 2; i++) await delay(500);
    assert.ok(fixture.stats.patches.length >= 2, "A lost response should reconcile and continue");
    await page.getByRole("button", { name: "暂停上传", exact: true }).click();
    await page.getByText("上传已暂停，已确认的数据保留。", { exact: true }).waitFor();
    assert.equal(fixture.stats.lostResponses, 1);
    assert.deepEqual(fixture.stats.patches.slice(0, 2).map(p => p.offset), [0, 1048576]);
    await page.screenshot({ path: path.join(fixture.output, "paused-desktop.png"), fullPage: true });
    const id = await page.evaluate(() => localStorage.getItem("video-upload-session-v1"));
    assert.ok(id);
    assert.equal(await page.evaluate(token => Object.values(localStorage).some(value => value.includes(token)), fixture.token), false);
    pass("256 Kbps upload, lost ACK reconciliation, pause and credential-free persistence");

    await page.reload();
    await page.getByRole("button", { name: "恢复上传 / 刷新状态", exact: true }).waitFor();
    await page.getByLabel("上传令牌", { exact: true }).fill("wrong-token");
    await page.getByRole("button", { name: "恢复上传 / 刷新状态", exact: true }).click();
    await page.getByText(/Missing or invalid upload API token/).waitFor();
    await page.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
    await page.getByRole("button", { name: "恢复上传 / 刷新状态", exact: true }).click();
    await page.getByLabel("重新选择原文件", { exact: true }).waitFor();
    pass("Page reload restores the same session; invalid token preserves recovery");

    // The first/last fingerprint is unchanged, but a confirmed interior byte differs.
    const changedDir = path.join(fixture.temp, "changed"); await fs.mkdir(changedDir);
    const changed = path.join(changedDir, path.basename(fixture.video));
    const content = await fs.readFile(fixture.video); content[100000] ^= 1; await fs.writeFile(changed, content);
    await page.getByLabel("重新选择原文件", { exact: true }).setInputFiles(changed);
    await page.getByRole("button", { name: "继续上传", exact: true }).click();
    await page.getByText(/File contents changed/).waitFor();
    await page.getByLabel("重新选择原文件", { exact: true }).setInputFiles(fixture.video);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(fixture.output, "recovery-mobile.png"), fullPage: true });
    pass("Changed original rejected by prefix hashes; recovery fits a 390px viewport");

    fixture.stats.rate = 125_000;
    await page.getByRole("button", { name: "继续上传", exact: true }).press("Enter");
    console.log("Resuming remaining bytes at 1 Mbps");
    await page.waitForFunction(() => document.querySelector(".upload-status")?.textContent?.includes("上传完成，服务器已检测到元数据。")
      || document.querySelector(".upload-status.error"), null, { timeout: 90000 });
    assert.match(await page.locator(".upload-status").innerText(), /上传完成，服务器已检测到元数据。/);
    assert.equal(fixture.stats.creates, 1);
    assert.equal(fixture.collections.video_projects.length, 1);
    assert.equal(fixture.collections.video_masters.length, 1);
    assert.equal(fixture.collections.video_masters[0].verification_status, "ready");
    const original = await fs.readFile(path.join(fixture.temp, fixture.collections.video_masters[0].file_url.replace("/media/", "media/")));
    assert.deepEqual(original, await fs.readFile(fixture.video));
    await page.screenshot({ path: path.join(fixture.output, "success-mobile.png"), fullPage: true });
    pass("1 Mbps resume through real FFmpeg verification and a single CMS publication; source bytes unchanged");

    const complete = await fetch(`http://127.0.0.1:18060/uploads/video-sessions/${id}/complete`, {
      method: "POST", headers: { Authorization: `Bearer ${fixture.token}` },
    });
    assert.equal(complete.status, 202); assert.equal((await complete.json()).state, "completed");
    assert.equal(fixture.collections.video_masters.length, 1);
    await page.getByRole("button", { name: "English", exact: true }).click();
    await page.getByRole("heading", { name: "Upload task", exact: true }).waitFor();
    assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "100");
    assert.deepEqual(report.consoleErrors, []);
    pass("Repeated completion is idempotent; keyboard resume and English task controls work");
    await context.tracing.stop({ path: path.join(fixture.output, "webkit-trace.zip") });
    report.stats = fixture.stats; report.videoBytes = content.length; report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.stack;
    if (page) {
      await page.screenshot({ path: path.join(fixture.output, "browser-failure.png"), fullPage: true }).catch(() => {});
      report.pageText = await page.locator("body").innerText().catch(() => "");
    }
    console.error(error); process.exitCode = 1;
  } finally {
    await fs.writeFile(path.join(fixture.output, "browser-report.json"), JSON.stringify(report, null, 2));
    await browser?.close(); await fixture.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
