const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const sharp = require("sharp");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  const fixture = await startFixture({ name: "project", cmsPort: 18097, apiPort: 18096, webPort: 13006 });
  const report = { browser: "headless WebKit", checks: [], errors: [], errorDetails: [], failedRequests: [], passed: false };
  const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };
  // A real second origin with a continuously changing picture; no target-site modifications.
  const exhibit = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(req.url === "/blocked" ? { "X-Frame-Options": "DENY" } : {}) });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
      *{box-sizing:border-box}body{margin:0;background:#090b10;color:#cdd5dd;font:16px system-ui;height:100vh;display:grid;place-content:center;text-align:center;overflow:hidden}
      .ring{width:230px;height:230px;border:12px solid #b49973;border-left-color:#252c38;border-right-color:#e6cf9f;border-radius:50%;box-shadow:0 0 60px #b4997350;animation:orbit 8s linear infinite}
      @keyframes orbit{to{transform:rotate(360deg)}}p{margin-top:40px;font-size:14px}#ticks{font-variant-numeric:tabular-nums;color:#718192}
      </style></head><body><div class="ring"></div><p>跨域动态展示验收</p><output id="ticks">0</output><a href="/second" style="color:#718192">内部页面</a>
      <script>let n=0;setInterval(()=>document.getElementById('ticks').textContent=String(++n),100)</script></body></html>`);
  });
  let browser;
  let page;
  try {
    await new Promise((resolve, reject) => { exhibit.once("error", reject); exhibit.listen(18098, "127.0.0.1", resolve); });
    browser = await webkit.launch({ headless: true, executablePath: process.env.WEBKIT_EXECUTABLE || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("pageerror", error => { report.errors.push(error.message); report.errorDetails.push({ message: error.message, stack: error.stack, after: report.checks.at(-1) || "initialization" }); });
    page.on("requestfailed", request => report.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText, after: report.checks.at(-1) || "initialization" }));
    await page.goto(`${fixture.url}/project`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "作品整理中" }).waitFor();
    const tools = page.getByRole("button", { name: "工具", exact: true });
    assert.equal(await tools.count(), 0);
    assert.equal(await page.getByRole("link", { name: "添加网站", exact: true }).count(), 0);
    assert.equal((await context.request.get(`${fixture.url}/api/external-projects/manage`)).status(), 401);
    assert.equal((await context.request.post(`${fixture.url}/api/external-projects`, { data: {} })).status(), 401);
    await page.keyboard.press("Control+Alt+Shift+L");
    const login = page.getByRole("dialog", { name: "作者登录", exact: true });
    await login.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await login.waitFor({ state: "hidden" });
    await tools.click();
    const menu = page.locator(".author-menu");
    assert.equal(await menu.locator(".action-menu-item").first().getAttribute("aria-label"), "添加网站");
    await page.getByRole("link", { name: "添加网站", exact: true }).click();
    const form = page.getByRole("dialog", { name: "添加网站", exact: true });
    await form.waitFor();
    await form.getByRole("button", { name: "保存草稿", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "title");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")), "title");
    await form.getByLabel("网站名称 *", { exact: true }).fill("黑洞演示");
    await form.getByLabel("网站地址 *", { exact: true }).fill("http://127.0.0.1:18098/site");
    await form.getByLabel("一句话介绍", { exact: true }).fill("光线与空间的视觉实验");
    const png = await sharp({ create: { width: 960, height: 600, channels: 3, background: "#252b35" } }).png().toBuffer();
    await form.getByLabel("封面图片", { exact: true }).setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: png });
    await page.screenshot({ path: path.join(fixture.output, "create-desktop.png") });
    await form.getByRole("button", { name: "保存草稿", exact: true }).click();
    await form.waitFor({ state: "hidden" }); await page.waitForURL(`${fixture.url}/project`);
    await page.getByText("草稿已保存，可在管理网站中继续编辑。", { exact: true }).waitFor();
    let published = await (await context.request.get(`${fixture.url}/api/external-projects`)).json();
    assert.equal(published.projects.length, 0);
    const session = await (await context.request.get(`${fixture.url}/api/author/session`)).json();
    const headers = { Origin: fixture.url, "X-Author-CSRF": session.csrf };
    const managed = await (await context.request.get(`${fixture.url}/api/external-projects/manage`, { headers })).json();
    const created = managed.projects[0];
    assert.ok(created.cover_image); assert.equal(created.published, false);
    assert.equal((await context.request.get(`${fixture.url}/api/assets/${created.cover_image}`)).status(), 404);
    assert.equal((await context.request.get(`${fixture.url}/api/assets/${created.cover_image}`, { headers })).status(), 200);
    assert.equal((await context.request.patch(`${fixture.url}/api/external-projects/${created.id}`, { data: { published: true } })).status(), 403);
    pass("unified author-only creation, validation, real cover upload, private drafts and CSRF protection");

    await page.getByRole("button", { name: "管理网站", exact: true }).click();
    await page.getByRole("button", { name: "管理黑洞演示", exact: true }).click();
    await page.getByRole("button", { name: "发布到实验室", exact: true }).click();
    await page.getByText("网站已发布到实验室。", { exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    // The preceding anonymous draft probe deliberately populated the existing
    // two-second negative asset cache; allow that denial to expire on publication.
    let coverStatus = 404;
    for (let attempt = 0; attempt < 30 && coverStatus === 404; attempt++) {
      coverStatus = (await context.request.get(`${fixture.url}/api/assets/${created.cover_image}`)).status();
      if (coverStatus === 404) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(coverStatus, 200);
    await page.getByRole("button", { name: "返回公开展示", exact: true }).click();
    const card = page.getByRole("button", { name: "查看黑洞演示", exact: true });
    await card.waitFor();
    const preview = page.locator('ol[aria-label="网站作品"] iframe');
    await preview.waitFor();
    assert.equal(await preview.count(), 1);
    assert.equal(await preview.evaluate(element => Boolean(element.closest("[inert]"))), true);
    const frame = page.frames().find(frame => frame.url().includes("18098/site")) || await preview.elementHandle().then(handle => handle.contentFrame());
    await frame.waitForSelector("#ticks");
    const tick = await frame.locator("#ticks").innerText();
    await frame.waitForFunction(value => document.getElementById("ticks").textContent !== value, tick);
    await page.screenshot({ path: path.join(fixture.output, "preview-desktop.png") });
    assert.equal((await page.locator('ol[aria-label="网站作品"]').innerText()).replace(/\s+/g, " "), "站内查看 黑洞演示 光线与空间的视觉实验");
    const scroll = await page.evaluate(() => scrollY);
    await card.click();
    const viewer = page.getByRole("dialog", { name: "黑洞演示", exact: true });
    await viewer.waitFor();
    assert.equal(await preview.count(), 0);
    assert.equal(await viewer.locator("iframe").count(), 1);
    assert.equal(await page.getByRole("button", { name: "页面工具", exact: true }).isVisible(), false);
    const box = await viewer.boundingBox();
    assert.equal(Math.round(box.width), 1280); assert.equal(Math.round(box.height), 900);
    const fullFrame = await viewer.locator("iframe").elementHandle().then(handle => handle.contentFrame());
    await fullFrame.getByRole("link", { name: "内部页面" }).click();
    await page.screenshot({ path: path.join(fixture.output, "viewer-desktop.png") });
    await viewer.getByRole("button", { name: "← 返回实验室", exact: true }).click();
    await viewer.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => scrollY), scroll);
    assert.equal(await card.evaluate(element => document.activeElement === element), true);
    pass("read-only live preview without hover, frames removed behind the viewer, full-window viewing, nested navigation and focus/scroll restoration");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => !document.querySelector('ol[aria-label="网站作品"] iframe'));
    await card.click(); await viewer.waitFor();
    await viewer.getByRole("button", { name: "← 返回实验室", exact: true }).click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    pass("reduced motion suppresses automatic previews without disabling full viewing");

    await page.getByRole("button", { name: "管理网站", exact: true }).click();
    await page.getByRole("button", { name: "管理黑洞演示", exact: true }).click();
    await page.getByRole("button", { name: "编辑网站", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑网站", exact: true });
    await edit.getByLabel("一句话介绍", { exact: true }).fill("更新后的介绍");
    await edit.getByRole("button", { name: "关闭", exact: true }).click();
    const discard = page.getByRole("dialog", { name: "放弃未保存的更改？", exact: true });
    await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
    assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden",
      "Closing only the confirmation must keep the editor's scroll lock.");
    await edit.getByLabel("预览地址", { exact: true }).fill("unfinished-url");
    await edit.getByLabel("启用卡片实时预览", { exact: true }).uncheck();
    await page.route(`**/api/external-projects/${created.id}`, route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture unavailable"}' }));
    await edit.getByRole("button", { name: "保存更改", exact: true }).click();
    await edit.getByRole("alert").waitFor();
    assert.equal(await edit.getByLabel("一句话介绍", { exact: true }).inputValue(), "更新后的介绍");
    await page.unroute(`**/api/external-projects/${created.id}`);
    await edit.getByRole("button", { name: "保存更改", exact: true }).click();
    await edit.waitFor({ state: "hidden" });
    // Finish the save's RSC refresh before a test-owned hard navigation. WebKit
    // otherwise reports cancellation of Next's pending document resources.
    await page.waitForLoadState("networkidle");
    const edited = (await (await context.request.get(`${fixture.url}/api/external-projects/manage`, { headers })).json()).projects.find(item => item.id === created.id);
    assert.equal(edited.preview_enabled, false); assert.equal(edited.preview_url, null);
    await context.request.patch(`${fixture.url}/api/external-projects/${created.id}`, { headers, data: { preview_enabled: true } });
    pass("editing preserves input after failure and guards unsaved dismissal");

    await context.request.post(`${fixture.url}/api/external-projects`, { headers, data: {
      title: "禁止嵌入的作品", description: "用于验证返回入口", url: "http://127.0.0.1:18098/blocked", published: true, sort_order: 1,
    } });
    await page.goto(`${fixture.url}/project`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "查看禁止嵌入的作品", exact: true }).click();
    const denied = page.getByRole("dialog", { name: "禁止嵌入的作品", exact: true });
    assert.equal(await denied.getByRole("link", { name: "独立打开 ↗" }).getAttribute("href"), "http://127.0.0.1:18098/blocked");
    await denied.getByRole("button", { name: "← 返回实验室", exact: true }).click();
    pass("a frame-denied website cannot trap the reader or hide the independent-open fallback");

    await context.request.post(`${fixture.url}/api/external-projects`, { headers, data: {
      title: "下方展品", url: "http://127.0.0.1:18098/site", published: true, sort_order: 2,
    } });
    await page.goto(`${fixture.url}/project`, { waitUntil: "networkidle" });
    const lowerCard = page.getByRole("button", { name: "查看下方展品", exact: true });
    await lowerCard.scrollIntoViewIfNeeded();
    const lowerScroll = await page.evaluate(() => scrollY);
    assert.ok(lowerScroll > 0, "Exercise a genuinely scrolled list, not only its first row.");
    const lowerItem = page.locator("li", { has: lowerCard });
    const glyph = lowerItem.locator("[data-waiting] span");
    assert.equal(await glyph.evaluate(element => getComputedStyle(element).visibility), "hidden");
    await lowerItem.locator("iframe").waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await lowerItem.locator("iframe").waitFor({ state: "detached" });
    assert.equal(await glyph.evaluate(element => getComputedStyle(element).visibility), "visible");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await lowerItem.locator("iframe").waitFor();
    pass("a coverless card previews directly without flashing its placeholder; reduced motion keeps the placeholder");
    await lowerCard.click();
    await page.getByRole("dialog", { name: "下方展品", exact: true }).getByRole("button", { name: "← 返回实验室", exact: true }).click();
    assert.equal(await page.evaluate(() => scrollY), lowerScroll);
    assert.equal(await lowerCard.evaluate(element => document.activeElement === element), true);
    pass("return preserves a nonzero list scroll position and the originating lower-row card focus");

    const originalOverflow = await page.evaluate(() => document.body.style.overflow);
    await tools.click();
    await page.getByRole("link", { name: "添加网站", exact: true }).click();
    await form.getByLabel("网站名称 *", { exact: true }).fill("未保存的网站");
    await form.getByRole("button", { name: "关闭", exact: true }).click();
    await discard.getByRole("button", { name: "放弃更改", exact: true }).click();
    await form.waitFor({ state: "hidden" });
    await discard.waitFor({ state: "hidden" });
    await page.waitForURL(`${fixture.url}/project`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.evaluate(() => document.body.style.overflow), originalOverflow,
      "Simultaneously unmounting both dialogs must restore the original page overflow.");
    // Verify the visible consequence on the already-scrollable list, not just the style.
    await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(40, 400);
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => scrollY > 0, null, { timeout: 5000 });
    await page.screenshot({ path: path.join(fixture.output, "discard-restores-scroll.png") });
    pass("discarding nested dialogs releases the page scroll lock while continuing edits keeps it");

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phone = await mobile.newPage();
    await phone.goto(`${fixture.url}/project`, { waitUntil: "networkidle" });
    const phoneFrames = phone.locator('ol[aria-label="网站作品"] iframe');
    await phoneFrames.first().waitFor();
    assert.equal(await phoneFrames.count(), await phone.locator("[data-preview-id]").evaluateAll(cards =>
      cards.filter(card => { const box = card.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight; }).length),
      "Only on-screen cards run a frame.");
    assert.ok(await phoneFrames.count() < await phone.locator("[data-preview-id]").count(), "Exercise a card below the fold.");
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await phone.screenshot({ path: path.join(fixture.output, "gallery-mobile.png") });
    await phone.getByRole("button", { name: "查看黑洞演示", exact: true }).tap();
    const mobileViewer = phone.getByRole("dialog", { name: "黑洞演示", exact: true });
    await mobileViewer.waitFor();
    const mobileBox = await mobileViewer.boundingBox();
    assert.equal(Math.round(mobileBox.width), 390); assert.equal(Math.round(mobileBox.height), 844);
    await phone.screenshot({ path: path.join(fixture.output, "viewer-mobile.png") });
    await mobileViewer.getByRole("button", { name: "← 返回实验室", exact: true }).tap();
    await mobileViewer.waitFor({ state: "hidden" }); await mobile.close();
    pass("mobile automatic preview, one-column layout, no horizontal overflow and reachable full-screen return");

    await context.request.patch(`${fixture.url}/api/external-projects/${created.id}`, { headers, data: { published: false } });
    assert.equal((await context.request.get(`${fixture.url}/api/assets/${created.cover_image}`)).status(), 404);
    published = await (await context.request.get(`${fixture.url}/api/external-projects`)).json();
    assert.equal(published.projects.some(item => item.id === created.id), false);
    pass("unpublishing removes the public record and revokes cover access immediately");
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) await page.screenshot({ path: path.join(fixture.output, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await fs.writeFile(path.join(fixture.output, "report.json"), JSON.stringify(report, null, 2));
    if (browser) await browser.close();
    exhibit.closeAllConnections(); await new Promise(resolve => exhibit.close(resolve));
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
