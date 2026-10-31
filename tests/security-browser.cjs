// Run after HOLD_FIXTURE=1 node tests/security-cms-integration.cjs.
// Only the disposable fixture is used, in a fresh headless WebKit browser context.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "test-results/security-remediation-2026-10-22/browser");
(async () => {
  const fixture = JSON.parse(await fs.readFile(path.join(output, "../cms-integration/fixture.json"), "utf8"));
  await fs.mkdir(output, { recursive: true });
  const report = { browser: "headless WebKit", status: "running", checks: [], errors: [] };
  const browser = await webkit.launch({ headless: true, executablePath: process.env.WEBKIT_EXECUTABLE_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  try {
    await page.goto(fixture.web + "/albums");
    await page.getByRole("link", { name: /隔离测试相簿.*共 1 张照片/ }).waitFor();
    await page.screenshot({ path: path.join(output, "album-index.png"), fullPage: true });
    await page.getByRole("button", { name: "上传照片", exact: true }).click();
    await page.getByLabel(/^管理员令牌/).fill(fixture.token);
    const list = page.waitForResponse(response => response.url().includes("/api/albums/manage?page=1"));
    await page.getByRole("button", { name: "验证令牌并加载草稿" }).click();
    assert.equal((await (await list).json()).albums[0].photos.length, 0);
    report.checks.push("Picker loads bounded summaries; public album count is correct");

    const detailRoute = `**/api/albums/${fixture.albumId}/manage`;
    await page.route(detailRoute, route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"相簿载入失败，请重试。"}' }));
    await page.getByRole("button", { name: "管理照片、封面与顺序" }).click();
    await page.getByRole("alert").filter({ hasText: "相簿载入失败" }).waitFor();
    await page.getByRole("heading", { name: "上传照片", exact: true }).waitFor();
    assert.equal(await page.getByLabel(/^管理员令牌/).inputValue(), fixture.token);
    await page.screenshot({ path: path.join(output, "manager-error.png"), fullPage: true });
    await page.unroute(detailRoute);
    report.checks.push("Failed detail load keeps the current form and displays an in-dialog retry error");

    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { entered = resolve; });
    await page.route(detailRoute, async route => { entered(); await gate; await route.continue(); });
    await page.getByRole("button", { name: "管理照片、封面与顺序" }).click();
    await requested;
    assert.equal(await page.getByRole("button", { name: "管理照片、封面与顺序" }).isDisabled(), true);
    await page.screenshot({ path: path.join(output, "manager-pending.png"), fullPage: true });
    release();
    await page.getByRole("heading", { name: "管理相簿", exact: true }).waitFor();
    await page.unroute(detailRoute);
    await page.getByRole("button", { name: "查看第 1 张照片" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "manager-loaded.png"), fullPage: true });
    report.checks.push("Pending detail load prevents duplicate activation and opens the selected gallery");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, "manager-mobile.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "相簿", exact: true }).waitFor();
    await page.getByRole("link", { name: /隔离测试相簿.*共 1 张照片/ }).click();
    await page.getByRole("button", { name: "查看第 1 张照片" }).waitFor();
    await page.screenshot({ path: path.join(output, "album-detail-mobile.png"), fullPage: true });
    report.checks.push("390px layout, keyboard dismissal and public detail navigation remain usable");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(fixture.web + "/albums");
    await page.getByRole("button", { name: "导入胶片扫描", exact: true }).click();
    await page.getByLabel(/^管理员令牌/).fill(fixture.token);
    const job = { id: 999, albumId: fixture.albumId, status: "uploaded", scanner: "hasselblad-x5", frameFormat: "135-full",
      filmType: "color-negative", filmStock: "Fixture", iso: 400, process: "c41", pushPull: 0, progress: 0,
      frames: [], warnings: [], experimentalCompatibility: false, error: null,
      rollAdjustments: { maskMode: "auto", maskRgb: null, filmBaseSample: null, exposure: 0, temperature: 0, tint: 0,
        blackPoint: [0,0,0], whitePoint: [1,1,1], contrast: 0, saturation: 0, highlightRolloff: 0.25 } };
    let active = 0, peak = 0, polls = 0, fullReads = 0;
    await page.route("**/api/albums/*/film-scans**", async route => {
      const req = route.request();
      if (req.method() === "POST") return route.fulfill({ json: { status: "ok", job } });
      if (req.url().includes("progressOnly=true")) {
        active++; peak = Math.max(peak, active); polls++;
        await new Promise(resolve => setTimeout(resolve, 2000));
        active--;
        const { frames, ...summary } = job;
        return route.fulfill({ json: { status: "ok", job: { ...summary, status: polls < 2 ? "analyzing" : "review_required" } } });
      }
      fullReads++; return route.fulfill({ json: { status: "ok", job: { ...job, status: "review_required" } } });
    });
    await page.locator('input[type="file"]').setInputFiles({ name: "fixture.jpg", mimeType: "image/jpeg", buffer: Buffer.from([255,216,255,217]) });
    await page.getByRole("button", { name: "上传并开始分析", exact: true }).click();
    await page.getByText("待审核", { exact: true }).waitFor({ timeout: 20_000 });
    assert.equal(peak, 1); assert.equal(polls, 2); assert.equal(fullReads, 1);
    await page.screenshot({ path: path.join(output, "film-review.png"), fullPage: true });
    report.checks.push("Slow film polling never overlaps and loads full frames once at review readiness");
    assert.equal(await page.evaluate(token => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(token)), fixture.token), false);
    assert.deepEqual(report.errors, []);
    report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.failure = error.message;
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
    throw error;
  } finally {
    await context.tracing.stop({ path: path.join(output, "trace.zip") });
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
