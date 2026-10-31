const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { webkit } = require("playwright");
const { startAuthFixture } = require("./helpers/manager-auth-fixture.cjs");

async function main() {
  const output = path.resolve("test-results/manager-auto-install");
  await fs.mkdir(output, { recursive: true });
  const fixture = await startAuthFixture();
  const report = { browser: "headless WebKit", checks: [], errors: [], passed: false };
  let browser, page, release;
  try {
    // Exercise real authenticated HTTP dispatch, orchestration and the journal.
    // Only Windows process/npm/DB effects are simulated; no installed service is touched.
    fixture.context.installGate = new Promise(resolve => { release = resolve; });
    vm.runInContext(`
      process.env.MANAGER_WEB_MODE="production";
      var calls=[], installFails=true, fixtureStatus=allStatus;
      allStatus=async()=>({...await fixtureStatus(),operation:await operationJournal.read()});
      handleAction=module.exports.handleAction;
      handleStackAction=module.exports.handleStackAction;
      stopProcessService=async service=>{calls.push(service.id+":stop");return {message:"Stopped"}};
      startProcessService=async service=>{calls.push(service.id+":start");return {message:"Healthy"}};
      buildWeb=async()=>{calls.push("build");};
      installAppDependencies=async()=>{
        calls.push("install");await installGate;
        if(installFails)throw new Error("Dependency installation failed. API and Web remain stopped. Check logs/app.dependencies.err.log and retry Update API + Web.");
        return {message:"Dependencies installed"};
      };
      readServiceLogs=async id=>({serviceId:id,serviceName:id,stdout:"fixture npm install output",stderr:installFails?"fixture registry unavailable":"",
        files:{stdout:"logs/app.dependencies.out.log",stderr:"logs/app.dependencies.err.log"}});
    `, fixture.context);
    browser = await webkit.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", error => report.errors.push(error.message));
    const root = fixture.url + fixture.basePath;
    await page.goto(root);
    await page.getByLabel("账号", { exact: true }).fill("admin");
    await page.locator("#password").fill(fixture.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(root);
    const update = page.getByRole("button", { name: "Update API + Web", exact: true });
    await update.click();
    await page.getByRole("dialog").waitFor();
    assert.match(await page.locator("#actionDialogMessage").innerText(), /install their dependencies.*failure leaves API and Web stopped/);
    await page.locator("#actionDialogConfirm").click();
    await page.locator("#currentTasks").getByText("API 与 Web 依赖 · 安装依赖", { exact: true }).waitFor();
    assert.equal(await update.isDisabled(), true);
    assert.equal(vm.runInContext('calls.join(",")', fixture.context), "web:stop,api:stop,install");
    await page.getByRole("button", { name: "View dependency install log", exact: true }).click();
    await page.locator("#log").getByText("fixture registry unavailable", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "install-pending.png"), fullPage: true });
    report.checks.push("Confirmation, pending installation phase, duplicate prevention and live dependency logs");
    release();
    await page.waitForFunction(() => document.querySelector("#operationSummary").textContent.includes("Needs attention"));
    assert.equal(await update.isEnabled(), true);
    assert.equal(vm.runInContext('calls.join(",")', fixture.context), "web:stop,api:stop,install");
    await page.screenshot({ path: path.join(output, "install-failed.png"), fullPage: true });
    report.checks.push("Install failure is persistent and stops build/start while allowing an explicit retry");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    vm.runInContext('installFails=false;calls=[];', fixture.context);
    await update.focus();
    await page.keyboard.press("Enter");
    await page.locator("#actionDialogConfirm").click();
    await page.waitForFunction(() => document.querySelector("#operationSummary").textContent.includes("Completed · API + Web updated"));
    assert.equal(vm.runInContext('calls.join(",")', fixture.context), "web:stop,api:stop,install,build,api:start,web:start");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, "update-complete-mobile.png"), fullPage: true });
    report.checks.push("Keyboard retry completes in order; narrow dark/reduced-motion layout stays within viewport");
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    await page?.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    release?.();
    await fs.writeFile(path.join(output, "browser-report.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
