const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit, firefox } = require("playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  const engine = process.env.AUTHOR_BROWSER === "firefox" ? firefox : webkit;
  const fixture = await startFixture({ name: `author-session-${engine.name()}`, cmsPort: 18059, apiPort: 18064, webPort: 13004 });
  const report = { browser: `headless ${engine.name()}`, checks: [], errors: [], passed: false };
  let browser;
  let page;
  const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  try {
    const profile = path.join(fixture.temp, "browser-profile");
    let context = await engine.launchPersistentContext(profile, { headless: true });
    browser = context;
    page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });
    assert.equal(await page.locator(".author-menu").count(), 0);
    await page.keyboard.press("Control+Alt+Shift+L");
    const dialog = page.getByRole("dialog", { name: "作者登录", exact: true });
    await dialog.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const original = await (await context.request.get(`${fixture.url}/api/author/session`)).json();
    assert.equal(original.author, true);

    // A new window shares cookies but starts with a fresh client module store.
    page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(`${fixture.url}/upload`, { waitUntil: "networkidle" });
    await page.getByText("已作为作者登录", { exact: true }).waitFor();
    await page.getByRole("button", { name: "工具", exact: true }).waitFor();
    await page.screenshot({ path: path.join(fixture.output, "new-window.png") });
    pass("new same-browser window restores the existing author session");

    await context.close();
    context = await engine.launchPersistentContext(profile, { headless: true });
    browser = context;
    page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(`${fixture.url}/upload`, { waitUntil: "networkidle" });
    await page.getByText("已作为作者登录", { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "工具", exact: true }).waitFor();
    await page.screenshot({ path: path.join(fixture.output, "browser-reopened.png") });
    pass("closing and reopening the browser with the same disposable profile preserves login");
    const first = page;
    page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));

    // Display hints are not credentials and must not gate session restoration.
    await context.clearCookies({ name: /^author_(hint|device)$/ });
    await page.goto(`${fixture.url}/upload`, { waitUntil: "networkidle" });
    await page.getByText("已作为作者登录", { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "工具", exact: true }).waitFor();
    assert.deepEqual(await (await context.request.get(`${fixture.url}/api/author/session`)).json(), original);
    await page.screenshot({ path: path.join(fixture.output, "restored-without-hints.png") });
    pass("valid HttpOnly session restores author controls without display hints or renewing expiry");

    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("button", { name: "退出", exact: true }).click();
    await first.getByText("已作为作者登录", { exact: true }).waitFor({ state: "hidden" });
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.getByText("已作为作者登录", { exact: true }).count(), 0);
    pass("logout synchronizes across windows and cannot be undone by reloading");

    await context.addCookies([
      { name: "author_hint", value: "1", url: fixture.url },
      { name: "author_device", value: "1", url: fixture.url },
    ]);
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.getByText("已作为作者登录", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByText("登录已过期", { exact: true }).waitFor();
    await page.getByRole("button", { name: "退出并忘记此设备", exact: true }).click();
    await page.locator(".author-menu").waitFor({ state: "detached" });
    assert.equal((await context.cookies()).some(cookie => cookie.name === "author_device"), false);
    pass("display hints cannot restore authorization and forgetting a device removes its tools");
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    await page?.screenshot({ path: path.join(fixture.output, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await fs.writeFile(path.join(fixture.output, "report.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
