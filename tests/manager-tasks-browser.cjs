const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startFixture } = require("./helpers/manager-task-fixture.cjs");

(async () => {
  // Headless WebKit uses a disposable context, with no personal browser profile.
  const output = path.resolve("test-results/manager-tasks");
  await fs.mkdir(output, { recursive: true });
  const fixture = await startFixture();
  const report = { browser: "headless WebKit", checks: [], errors: [] };
  let browser;
  try {
    browser = await webkit.launch({ headless: true, executablePath: process.env.WEBKIT_EXECUTABLE_PATH || undefined });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(fixture.url);
    await page.getByText("当前没有正在执行的任务", { exact: true }).waitFor();
    report.checks.push("Empty state");
    for (const [id, name] of [["postgres", "PostgreSQL"], ["cms", "CMS"], ["api", "API"], ["web", "web"]]) {
      await page.locator('[data-id="' + id + '"][data-action="restart"]').click();
      await page.locator("#actionDialogConfirm").click();
      await page.getByText("当前正在重启" + name, { exact: true }).waitFor();
      assert.equal(await page.locator('[data-id="' + id + '"][data-action="restart"]').isDisabled(), true);
      fixture.operation.steps = [{ serviceId: id, phase: "start", state: "running" }];
      await page.reload();
      await page.getByText(name + " · 启动并检查健康状态", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, id + "-running.png"), fullPage: true });
      fixture.operation.state = "succeeded"; fixture.operation.message = "Fixture completed";
      await page.getByText("当前没有正在执行的任务", { exact: true }).waitFor();
      report.checks.push(id + ": restart, duplicate prevention, phase polling, reload and completion");
    }
    fixture.begin("restart-all");
    fixture.operation.steps = [{ serviceId: "cms", phase: "stop", state: "running" }];
    await page.reload();
    await page.getByText("当前正在重启全部服务", { exact: true }).waitFor();
    await page.getByText("CMS · 停止并等待退出", { exact: true }).waitFor();
    fixture.offline = true;
    await page.locator("#taskConnectionStatus").filter({ hasText: /无法|尚未确认/ }).waitFor();
    assert.equal(await page.getByText("当前正在重启全部服务", { exact: true }).isVisible(), true);
    fixture.offline = false;
    await page.locator("#refreshButton").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("taskConnectionStatus").textContent === "");
    report.checks.push("Batch phase, disconnect warning and keyboard refresh recovery");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    // Wait for WebKit's style update before capturing the emulated theme.
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "#0d1015"
      && matchMedia("(prefers-reduced-motion: reduce)").matches);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, "mobile-dark.png"), fullPage: true });
    await page.locator(".current-tasks").screenshot({ path: path.join(output, "current-tasks.png") });
    report.checks.push("390px dark/reduced-motion layout has no horizontal overflow");
    for (const state of ["failed", "interrupted"]) {
      fixture.begin("api:restart"); fixture.operation.state = state; fixture.operation.message = "Fixture " + state;
      await page.reload();
      await page.getByText("当前没有正在执行的任务", { exact: true }).waitFor();
      await page.locator("#operationSummary").filter({ hasText: "Fixture " + state }).waitFor();
      report.checks.push(state + ": cleared from current tasks, retained in details");
    }
    assert.deepEqual(report.errors, []);
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    await fixture.close();
    await fs.writeFile(path.join(output, "browser-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
