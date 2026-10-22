const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startAuthFixture } = require("./helpers/manager-auth-fixture.cjs");

(async () => {
  // Exercise the real login/session HTTP flow in an isolated headless WebKit
  // context. All credentials and managed services belong to the test fixture.
  const output = path.resolve(process.env.MANAGER_TEST_OUTPUT || "test-results/manager-login");
  await fs.mkdir(output, { recursive: true });
  const fixture = await startAuthFixture();
  const report = { browser: "headless WebKit", checks: [], errors: [] };
  let browser, releaseLogin;
  try {
    browser = await webkit.launch({ headless: true, executablePath: process.env.WEBKIT_EXECUTABLE_PATH || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
    const page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    const root = fixture.url + fixture.basePath;
    await page.goto(root);
    await page.waitForURL(root + "/login");
    await page.getByRole("heading", { name: "登录管理控制台" }).waitFor();
    // A response forged in developer tools cannot create a server-side session.
    await page.route("**/api/login", route => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
    await page.getByLabel("账号", { exact: true }).fill("attacker");
    await page.locator("#password").fill("forged-success");
    const redirected = page.waitForResponse(response => response.url() === root && response.status() === 303);
    await page.locator("#password").press("Enter");
    await redirected;
    await page.waitForURL(root + "/login");
    await page.getByRole("heading", { name: "登录管理控制台" }).waitFor();
    await page.unroute("**/api/login");
    assert.equal((await context.cookies()).some(item => item.name === "manager_session"), false);
    report.checks.push("Forged login success cannot access dashboard or obtain a session");
    // CSP blocks an injected DOM script; the legitimate hashed script still runs.
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.managerInjectedScript = true";
      document.body.append(script);
    });
    assert.equal(await page.evaluate(() => window.managerInjectedScript === true), false);
    report.checks.push("Injected inline script blocked by CSP");
    await page.screenshot({ path: path.join(output, "login-light.png") });
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByText("请输入账号。", { exact: true }).waitFor();
    assert.equal(await page.locator("#username").evaluate(node => node === document.activeElement), true);
    await page.getByLabel("账号", { exact: true }).fill("admin");
    await page.locator("#password").fill("wrong-password");
    await page.getByRole("button", { name: "显示密码" }).click();
    assert.equal(await page.locator("#password").getAttribute("type"), "text");
    await page.getByRole("button", { name: "隐藏密码" }).click();
    await page.locator("#password").press("Enter");
    await page.getByText("账号或密码不正确。", { exact: true }).waitFor();
    assert.equal(await page.locator("#username").inputValue(), "admin");
    assert.equal(await page.locator("#password").inputValue(), "");
    await page.screenshot({ path: path.join(output, "login-invalid.png") });
    report.checks.push("Redirect, required-field focus, keyboard login, visibility toggle and generic credential errors");

    await page.route("**/api/login", route => route.abort());
    await page.locator("#password").fill(fixture.password);
    await page.locator("#password").press("Enter");
    await page.getByText("暂时无法连接 Manager，请检查连接后重试。", { exact: true }).waitFor();
    assert.equal(await page.locator("#password").inputValue(), fixture.password);
    await page.unroute("**/api/login");
    report.checks.push("Connection failure preserves form values and allows retry");

    const gate = new Promise(resolve => { releaseLogin = resolve; });
    let attempts = 0;
    await page.route("**/api/login", async route => { attempts++; await gate; await route.continue(); });
    await page.locator("#password").press("Enter");
    await page.getByRole("button", { name: "正在登录…" }).waitFor();
    assert.equal(await page.locator("#loginButton").isDisabled(), true);
    await page.locator("#password").press("Enter");
    await page.screenshot({ path: path.join(output, "login-pending.png") });
    releaseLogin();
    await page.waitForURL(root);
    assert.equal(attempts, 1);
    await page.unroute("**/api/login");
    await page.getByRole("heading", { name: "当前任务", exact: true }).waitFor();
    const cookie = (await context.cookies()).find(item => item.name === "manager_session");
    assert.ok(cookie.httpOnly);
    assert.equal(cookie.sameSite, "Strict");
    assert.equal(cookie.path, "/manager");
    assert.equal(await page.evaluate(() => document.cookie.includes("manager_session")), false);
    assert.equal(await page.evaluate(secret => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(secret)), fixture.password), false);
    await page.reload();
    await page.getByRole("button", { name: "退出登录" }).waitFor();
    await page.screenshot({ path: path.join(output, "dashboard-session.png") });
    report.checks.push("One pending login, session cookie protections, no stored credentials, dashboard and reload");

    await page.route("**/api/logout", route => route.fulfill({ status: 503, contentType: "application/json", body: '{}' }));
    await page.getByRole("button", { name: "退出登录" }).click();
    await page.getByText("退出失败，请重试。", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "退出登录" }).isEnabled(), true);
    await page.unroute("**/api/logout");
    await page.getByRole("button", { name: "退出登录" }).click();
    await page.waitForURL(root + "/login");
    assert.equal((await context.cookies()).some(item => item.name === "manager_session"), false);
    await page.goto(root);
    await page.waitForURL(root + "/login");
    report.checks.push("Logout failure/retry, cookie removal and protected page after logout");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    // Verify a fresh dark-mode page as well as the initial light-mode page.
    await page.reload();
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "#0d1015"
      && getComputedStyle(document.querySelector("h1")).color === "rgb(232, 235, 241)"
      && matchMedia("(prefers-reduced-motion: reduce)").matches);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, "login-mobile-dark.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(output, "login-dark.png") });
    report.checks.push("Light/dark, reduced motion and 390px responsive layout");

    await page.getByLabel("账号", { exact: true }).fill("admin");
    await page.locator("#password").fill(fixture.password);
    await page.locator("#password").press("Enter");
    await page.waitForURL(root);
    await context.clearCookies();
    await page.waitForURL(root + "/login");
    report.checks.push("401 during automatic polling returns to login without a Basic-auth prompt");

    // Two login pages share cookies but keep separate rendered nonces. Cover both
    // a service command and logout, without ever running a real managed service.
    for (const route of ["/api/services/web/restart", "/api/logout"]) {
      const tabs = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      try {
        const older = await tabs.newPage(), newer = await tabs.newPage();
        for (const tab of [older, newer]) {
          tab.on("pageerror", error => report.errors.push(error.message));
          await tab.goto(root + "/login");
        }
        for (const tab of [older, newer]) {
          await tab.locator("#username").fill("admin");
          await tab.locator("#password").fill(fixture.password);
          await tab.locator("#loginButton").click();
          await tab.waitForURL(root);
          await tab.getByText("当前没有正在执行的任务", { exact: true }).waitFor();
        }
        const status = older.waitForResponse(response => response.url() === root + "/api/status");
        await older.locator("#refreshButton").click();
        assert.equal((await status).status(), 200);
        let attempts = 0;
        older.on("request", request => {
          if (request.method() === "POST" && request.url() === root + route) attempts++;
        });
        const rejected = older.waitForResponse(response => response.url() === root + route);
        if (route === "/api/logout") await older.locator("#logoutButton").click();
        else {
          await older.locator('[data-id="web"][data-action="restart"]').click();
          await older.locator("#actionDialogConfirm").click();
        }
        assert.equal((await rejected).status(), 403);
        await older.getByText("登录状态已更新。上次操作未执行，请重新确认后操作。", { exact: true }).waitFor();
        await older.getByText("当前没有正在执行的任务", { exact: true }).waitFor();
        assert.equal(older.url(), root, "The temporary recovery marker is removed from the URL");
        assert.equal(attempts, 1, "Session recovery must not replay the rejected POST");
        await older.screenshot({ path: path.join(output, route === "/api/logout" ? "logout-session-recovered.png" : "command-session-recovered.png") });
        // The refreshed page must still display ordinary 403 failures without a reload.
        await older.route("**/api/logout", request => request.fulfill({ status: 403, contentType: "application/json", body: '{"error":"Denied"}' }));
        await older.locator("#logoutButton").click();
        await older.getByText("退出失败，请重试。", { exact: true }).waitFor();
        await older.unroute("**/api/logout");
        const logout = older.waitForResponse(response => response.url() === root + "/api/logout");
        await older.locator("#logoutButton").click();
        assert.equal((await logout).status(), 200);
        await older.waitForURL(root + "/login");
        assert.equal((await tabs.cookies()).some(item => item.name === "manager_session"), false);
        report.checks.push(route + ": stale tab reloads, explains rejection, never replays and can log out; unrelated 403 stays an error");
      } finally { await tabs.close(); }
    }
    assert.deepEqual(report.errors, []);
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    releaseLogin?.();
    if (browser) await browser.close();
    await fixture.close();
    await fs.writeFile(path.join(output, "browser-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
