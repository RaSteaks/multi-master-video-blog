const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { webkit } = require("playwright");
const { startAuthFixture } = require("./helpers/manager-auth-fixture.cjs");

async function main() {
  const linux = process.argv.includes("--linux");
  const output = path.resolve(linux ? "test-results/manager-repo-linux" : "test-results/manager-repo");
  await fs.mkdir(output, { recursive: true });
  // Real Git, authentication, HTTP dispatch and journal against local repositories.
  // Only Windows service, npm and restart effects are simulated.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-repo-browser-"));
  const globalConfig = path.join(dir, "gitconfig");
  await fs.writeFile(globalConfig, "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = path.join(dir, "origin.git"), author = path.join(dir, "author"), checkout = path.join(dir, "checkout");
  const write = async (root, file, content) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  };
  const publish = async (files, message) => {
    for (const [file, content] of Object.entries(files)) await write(author, file, content);
    git(author, "add", ".");
    git(author, "commit", "--quiet", "-m", message);
    git(author, "push", "--quiet", "origin", "HEAD:main");
    return git(author, "rev-parse", "HEAD");
  };
  git(dir, "init", "--bare", "--quiet", remote);
  git(dir, "clone", "--quiet", remote, author);
  await publish({ "apps/api/src/server.cjs": "v1\n", "apps/web/src/page.tsx": "v1\n", "scripts/manager-dashboard.cjs": "v1\n", "deployment/docker/compose.yaml": "v1\n" }, "Initial");
  git(dir, "clone", "--quiet", remote, checkout);

  const fixture = await startAuthFixture({ root: checkout, env, platform: linux ? "linux" : "win32" });
  const report = { browser: "headless WebKit", checks: [], errors: [], passed: false };
  let browser, page;
  try {
    vm.runInContext(`
      var calls = [], managerChanged = [], fixtureStatus = allStatus;
      var supervisor = { kind: "windows-process", script: "deployment/windows/manager-service.ps1", canRestart: true };
      // The vm fixture has no require.cache; mark the file a real Manager loads.
      loadedCode.set("scripts/manager-dashboard.cjs", {});
      allStatus = async () => ({ ...await fixtureStatus(), operation: await operationJournal.read(),
        manager: { host: "127.0.0.1", port: 8070, pid: 4321, uptime: 3725, node: "v22-fixture", rss: 73400320,
          eventLoop: { p99Ms: 2.4, maxMs: 9 }, changedCode: managerChanged, restart: managerRestart, activeOperation,
          supervisor } });
      handleAction = module.exports.handleAction;
      handleStackAction = module.exports.handleStackAction;
      stopProcessService = async service => { calls.push(service.id + ":stop"); return { message: "Stopped" }; };
      startProcessService = async service => { calls.push(service.id + ":start"); return { message: "Healthy" }; };
      installAppDependencies = async () => { calls.push("install"); return { message: "Dependencies installed" }; };
      buildWeb = async () => { calls.push("build"); };
      const realPrepare = repoUpdater.prepare, realFastForward = repoUpdater.fastForward;
      repoUpdater.prepare = target => { calls.push("verify"); return realPrepare(target); };
      repoUpdater.fastForward = plan => { calls.push("pull"); return realFastForward(plan); };
    `, fixture.context);
    if (linux) vm.runInContext(`
      readUnit = async () => ({ LoadState:"loaded", ActiveState:"active", WorkingDirectory:ROOT, User:"fixture", ExecStart:"npm run start:web" });
      controlSystemd = async (service, action) => { calls.push(service.id + ":" + action); };
      checkWebBuildUnit = async () => { calls.push("check-build"); };
      buildSystemdWeb = async () => { calls.push("build"); };
      const initialStatus = allStatus;
      allStatus = async () => {
        const status = await initialStatus();
        status.services.find(service => service.id === "web").mode = "production";
        return status;
      };
    `, fixture.context);
    const calls = () => vm.runInContext('calls.splice(0).join(",")', fixture.context);
    const notice = page => page.locator("#repoNotice");
    const waitForNotice = text => page.waitForFunction(value => document.querySelector("#repoNotice").textContent.includes(value), text);
    const waitForResult = text => page.waitForFunction(value => document.querySelector("#operationSummary").textContent.includes(value), text);

    browser = await webkit.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", error => report.errors.push(error.message));
    page.on("dialog", dialog => { report.errors.push("Unexpected native dialog: " + dialog.message()); dialog.dismiss(); });
    const root = fixture.url + fixture.basePath;
    await page.goto(root);
    await page.getByLabel("账号", { exact: true }).fill("admin");
    await page.locator("#password").fill(fixture.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(root);
    await waitForNotice("main matches origin/main");
    const pull = page.locator('[data-repo="pull"]');
    const pullUpdate = page.getByRole("button", { name: "Pull + Update API + Web", exact: true });
    assert.equal(await pull.isDisabled(), true);
    assert.match(await pull.getAttribute("title"), /Nothing to pull/);
    report.checks.push("An up-to-date checkout disables Pull with a reason");

    // A server customization of a tracked file survives an unrelated update.
    await write(checkout, "deployment/docker/compose.yaml", "server customization\n");
    const first = await publish({ "apps/api/src/server.cjs": "v2\n", "scripts/manager-dashboard.cjs": "v2\n" }, "Retry uploads <img src=x onerror=alert(1)>");
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    await waitForResult("Completed");
    await waitForNotice("1 new commit on origin/main. 1 local modification will be kept.");
    assert.equal(await page.locator("#repoIncoming img").count(), 0);
    assert.match(await page.locator("#repoIncoming").innerText(), /Retry uploads <img src=x onerror=alert\(1\)>/);
    assert.match(await page.locator("#repoIncoming .impact").innerText(), /Manager restart.*API/s);
    assert.equal(calls(), "");
    await page.screenshot({ path: path.join(output, "update-available.png"), fullPage: true });
    report.checks.push("Check for updates fetches, lists escaped commit subjects and the affected parts");

    await pull.click();
    const dialog = page.locator("#actionDialogMessage");
    await dialog.waitFor();
    if (linux) assert.match(await dialog.innerText(), /restart affected running checkout services \(api\)/);
    else assert.match(await dialog.innerText(), new RegExp("Fast-forward main from \\w{7} to " + first.slice(0, 7) + " \\(1 commit from origin/main\\)\\?.*keep running.*1 local modification will be kept.*restart Manager afterwards", "s"));
    await page.locator("#actionDialogConfirm").click();
    await waitForResult("Completed · Fast-forwarded main");
    assert.match(await page.locator("#operationSummary").innerText(), linux ? /Restarted api.*Restart Manager/ : /Run Update API \+ Web.*Restart Manager/);
    assert.equal(git(checkout, "rev-parse", "HEAD"), first);
    assert.equal(await fs.readFile(path.join(checkout, "deployment/docker/compose.yaml"), "utf8"), "server customization\n");
    assert.equal(calls(), linux ? "verify,pull,api:stop,api:start" : "verify,pull");
    await waitForNotice("main matches origin/main");
    report.checks.push("Pull fast-forwards to the confirmed commit, keeps local edits and reports service actions");

    const second = await publish({ "apps/web/src/page.tsx": "v2\n" }, "Refresh home page");
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    await waitForNotice("1 new commit on origin/main");
    if (linux) {
      await pull.click();
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /restart affected running checkout services \(web\).*Rebuild Production Web/);
      await page.locator("#actionDialogConfirm").click();
      await waitForResult("Rebuilt production Web. Restarted web.");
      assert.equal(git(checkout, "rev-parse", "HEAD"), second);
      assert.equal(calls(), "verify,check-build,pull,web:stop,build,web:start");
      await page.screenshot({ path: path.join(output, "production-web-updated.png"), fullPage: true });
      report.checks.push("Linux checkout Pull restarts only API, then rebuilds and restarts only production Web for the next commit");
      assert.deepEqual(report.errors, []);
      report.passed = true;
      return;
    }
    await page.waitForFunction(() => !document.querySelector('[data-repo="pull-update"]').disabled);
    await pullUpdate.click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /verified first.*Web and API stop.*leaves API and Web stopped/s);
    await page.locator("#actionDialogConfirm").click();
    await waitForResult("Completed · Pulled 1 commit to " + second.slice(0, 7) + " and updated API + Web.");
    assert.equal(calls(), "verify,web:stop,api:stop,pull,install,api:start,web:start");
    assert.equal(git(checkout, "rev-parse", "HEAD"), second);
    report.checks.push("Pull + Update API + Web verifies before stopping and updates the checkout only after both stop");

    await publish({ "deployment/docker/compose.yaml": "upstream compose\n" }, "Change compose");
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    await waitForNotice("Local changes to deployment/docker/compose.yaml conflict with the update");
    await page.waitForFunction(() => document.querySelector('[data-repo="pull"]').disabled && document.querySelector('[data-repo="pull-update"]').disabled);
    assert.equal(git(checkout, "rev-parse", "HEAD"), second);
    await page.screenshot({ path: path.join(output, "local-conflict.png"), fullPage: true });
    report.checks.push("A local edit to an incoming file blocks both pulls before any change");

    const managerPanel = page.locator("#managerPanel");
    const restart = page.getByRole("button", { name: "Restart Manager", exact: true });
    assert.match(await managerPanel.innerText(), /Running[\s\S]*1h 2m[\s\S]*70\.0 MiB[\s\S]*2\.4 ms[\s\S]*manager-service\.ps1/);
    vm.runInContext(`
      managerChanged = ["scripts/manager-dashboard.cjs"];
      supervisor = { kind: "systemd", unit: "video-blog-manager.service", unitState: "active", canRestart: false,
        reason: "Cannot confirm this Manager belongs to video-blog-manager.service. Restart it where it was started." };
    `, fixture.context);
    await page.waitForFunction(() => document.querySelector("#managerBadge").textContent === "Restart needed");
    assert.match(await page.locator("#managerIssue").innerText(), /differs from the running copy \(scripts\/manager-dashboard\.cjs\)/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(await restart.isDisabled(), true);
    assert.match(await page.locator("#managerIssue").innerText(), /Restart it where it was started/);
    await managerPanel.screenshot({ path: path.join(output, "manager-restart-blocked.png"), animations: "disabled" });
    vm.runInContext('supervisor.canRestart = true; delete supervisor.reason; activeOperation = "api:restart"', fixture.context);
    await page.getByText(/differs from the running copy.*Wait for the running operation/).waitFor();
    assert.equal(await restart.isDisabled(), true);
    vm.runInContext('activeOperation = null', fixture.context);
    await page.waitForFunction(() => !document.querySelector('[data-manager="restart"]').disabled);
    assert.match(await page.locator("#managerIssue").innerText(), /Restart Manager to load it/);
    // The button transitions to its warning color after the operation unlocks.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-manager="restart"]')).backgroundColor
      === getComputedStyle(document.querySelector("#managerBadge")).color);
    report.checks.push("Changed Manager code highlights an available restart and shows the reason for a blocked restart");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator("#repoPanel").screenshot({ path: path.join(output, "repository-mobile-dark.png") });
    await managerPanel.screenshot({ path: path.join(output, "manager-mobile-dark.png") });
    report.checks.push("Manager panel reports runtime facts and code that changed on disk; narrow dark layout fits");

    // The successor has no sessions, so the page must land on the login screen.
    vm.runInContext(`
      requestManagerRestart = async () => ({ ...(managerRestart = { state: "pending", pid: 4321, requestedAt: new Date().toISOString() }) });
      launchManagerRestart = () => { managerAuth.hasSession = () => false; };
    `, fixture.context);
    await restart.click();
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /keep running.*checks that its code on disk loads.*sign in again/s);
    await page.locator("#actionDialogConfirm").click();
    await page.waitForURL(url => url.pathname.endsWith("/login") && url.searchParams.get("restarted") === "1", { timeout: 20000 });
    await page.getByText("Manager 已重启，请重新登录。", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "restarted-login.png"), fullPage: true });
    report.checks.push("Restart Manager reconnects to the successor and explains the new sign-in");
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    await page?.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await fs.writeFile(path.join(output, "browser-report.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    await fixture.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
