const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const sharp = require("sharp");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  const fixture = await startFixture();
  const report = { browser: "headless WebKit", checks: [], errors: [], passed: false };
  let browser;
  let page;
  const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };
  try {
    browser = await webkit.launch({ headless: true, executablePath: process.env.WEBKIT_EXECUTABLE || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    const tools = page.getByRole("button", { name: "工具", exact: true });
    const publicTools = page.getByRole("button", { name: "页面工具", exact: true });
    const menu = page.locator(".author-menu");
    await page.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });
    assert.equal((await context.request.get(`${fixture.url}/api/author/tasks`)).status(), 401);
    assert.equal(await tools.count(), 0);
    assert.equal(await publicTools.count(), 0, "An unscrolled list has no page tools.");
    await page.screenshot({ path: path.join(fixture.output, "guest-desktop.png") });
    await page.keyboard.press("Control+Alt+Shift+L");
    const dialog = page.getByRole("dialog", { name: "作者登录", exact: true });
    await dialog.getByLabel("上传令牌", { exact: true }).fill("wrong");
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await dialog.getByText("令牌不正确，请检查后重试。", { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel("上传令牌", { exact: true }).inputValue(), "");
    await dialog.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    if (await tools.getAttribute("aria-expanded") !== "true") await tools.click();
    await menu.getByRole("link", { name: "上传照片", exact: true }).waitFor();
    // Capture the settled panel, not the first visible frame of its circular reveal.
    await menu.locator(".action-menu-panel").evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    const cookies = await context.cookies();
    const cookie = cookies.find(cookie => cookie.name === "author_session");
    const device = cookies.find(cookie => cookie.name === "author_device");
    assert.equal(device.httpOnly, false); assert.equal(device.path, "/"); assert.equal(device.sameSite, "Strict");
    assert.ok(device.expires * 1000 - Date.now() > 364 * 86400_000);
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.path, "/api"); assert.equal(cookie.sameSite, "Strict");
    assert.ok(cookies.every(cookie => !cookie.value.includes(fixture.token)));
    assert.equal(await page.evaluate(token => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(token)), fixture.token), false);
    await page.screenshot({ path: path.join(fixture.output, "author-desktop.png") });
    pass("guest tools, invalid login, immediate token clearing, real Next rewrite login and protected cookies");

    fixture.collections.film_scan_jobs = [{ id: 1, status: "analyzing", progress: 40, film_stock: "验收胶片" }];
    await menu.getByText("正在分帧 · 40%", { exact: true }).waitFor();
    assert.equal(await menu.locator(".author-task-dot").count(), 1);
    await page.screenshot({ path: path.join(fixture.output, "task-progress.png") });
    fixture.collections.film_scan_jobs[0].status = "review_required";
    fixture.collections.film_scan_jobs[0].progress = 100;
    await menu.getByText("任务已完成", { exact: true }).waitFor();
    await menu.locator('.author-task-dot[data-state="completed"]').waitFor();
    await page.waitForTimeout(3000);
    assert.equal(await menu.locator('.author-task-dot[data-state="completed"]').count(), 1);
    await menu.locator('.author-task-dot[data-state="completed"]').waitFor({ state: "detached", timeout: 5000 });
    await page.keyboard.press("Escape");
    fixture.collections.film_scan_jobs[0].status = "failed";
    await menu.locator('.author-task-dot[data-state="failed"]').waitFor();
    await page.waitForTimeout(6000);
    assert.equal(await menu.locator('.author-task-dot[data-state="failed"]').count(), 1);
    await tools.click();
    await menu.getByText("任务失败，请检查", { exact: true }).waitFor();
    await menu.locator('.author-task-dot[data-state="failed"]').waitFor({ state: "detached" });
    await page.waitForTimeout(5500);
    assert.equal(await menu.locator('.author-task-dot[data-state="failed"]').count(), 0);
    pass("session-protected task summaries show measured progress and bounded completion feedback");

    const failedVideo = "11111111-1111-4111-8111-111111111111";
    const taskRoute = "**/api/author/tasks", sessionRoute = `**/api/uploads/video-sessions/${failedVideo}`;
    await page.route(taskRoute, route => route.fulfill({ json: { tasks: [
      { id: `video:${failedVideo}`, kind: "video", label: "验收视频", state: "failed", progress: null }] } }));
    await page.route(sessionRoute, route => route.fulfill({ json: { id: failedVideo, state: "failed", phase: "processing",
      expiresAt: Date.now() + 3_600_000, chunkBytes: 1048576, fields: { title: "验收视频" }, files: [], result: null, error: "转码失败：验收原因" } }));
    const failedLink = menu.getByRole("link", { name: /验收视频/ });
    await failedLink.click();
    await page.waitForURL(`${fixture.url}/upload?session=${failedVideo}`);
    await page.getByText("转码失败：验收原因", { exact: true }).waitFor();
    await page.getByRole("button", { name: "重新上传", exact: true }).click();
    await page.getByText("转码失败：验收原因", { exact: true }).waitFor({ state: "detached" });
    assert.equal(new URL(page.url()).search, "");
    await tools.click();
    await failedLink.waitFor({ state: "detached", timeout: 7000 });
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await menu.locator('.author-task-dot[data-state="failed"]').count(), 0);
    await page.unroute(taskRoute); await page.unroute(sessionRoute);
    pass("a failed video links to its reason, and uploading again clears the task across reloads");

    for (const [label, query] of [["上传照片", "upload"], ["新建相簿", "create"], ["导入胶片扫描", "film"]]) {
      if (await tools.getAttribute("aria-expanded") !== "true") await tools.click();
      await menu.getByRole("link", { name: label, exact: true }).click();
      const albumDialog = page.getByRole("dialog", { name: label, exact: true });
      await albumDialog.waitFor(); assert.ok(page.url().includes(`dialog=${query}`));
      await albumDialog.getByRole("button", { name: "关闭", exact: true }).click();
      await page.waitForURL(`${fixture.url}/albums`);
      await page.waitForLoadState("networkidle");
    }
    pass("all album dialog links work repeatedly on the same page and clear their query on close");

    await page.goto(`${fixture.url}/posts/fixture-post`, { waitUntil: "networkidle" });
    await page.keyboard.press("n");
    assert.equal(await publicTools.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator(".create-menu").getByRole("link").count(), 0);
    await page.locator(".create-menu").getByRole("button", { name: "本页目录", exact: true }).click();
    await page.waitForFunction(() => Boolean(document.activeElement?.closest(".article-toc")));
    await tools.click();
    await page.keyboard.press("v");
    await page.waitForURL(`${fixture.url}/upload`);
    await page.getByText("已作为作者登录", { exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator(".create-menu").count(), 0);
    await page.goto(`${fixture.url}/posts/fixture-post`, { waitUntil: "networkidle" });
    await page.mouse.move(200, 200);
    await page.mouse.wheel(0, 400);
    await page.locator(".create-menu--retreated").waitFor();
    await page.waitForFunction(() => !document.querySelector(".create-menu--retreated"));
    assert.equal(await page.locator(".create-menu").evaluate(element => getComputedStyle(element).viewTransitionName), "create-menu");
    pass("public TOC/N, separate author V shortcut, scroll retreat and stable transition identity");

    const videoPath = path.join(fixture.temp, "playback.mp4");
    execFileSync(process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=10", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-chroma_sample_location", "left", videoPath]);
    await page.route("**/fixture-video.mp4", route => route.fulfill({ path: videoPath, contentType: "video/mp4" }));
    await page.evaluate(async () => {
      const video = document.createElement("video"); video.id = "fixture-video"; video.src = "/fixture-video.mp4"; video.muted = true; video.loop = true;
      document.querySelector("main").append(video); await video.play();
    });
    await page.locator(".create-menu--hidden[inert][aria-hidden=true]").waitFor({ state: "attached" });
    await page.evaluate(() => document.getElementById("fixture-video").pause());
    await page.waitForFunction(() => !document.querySelector(".create-menu--hidden"));
    await page.evaluate(() => document.getElementById("fixture-video").remove());
    pass("native video play hides and inerts the menu; pause restores it");
    await page.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });

    await page.goto(`${fixture.url}/albums/fixture-album`, { waitUntil: "networkidle" });
    await tools.click();
    assert.equal(await menu.locator(".action-menu-item").first().getAttribute("aria-label"), "上传到此相簿");
    await menu.getByRole("link", { name: "上传到此相簿", exact: true }).click();
    await page.getByLabel("相簿管理模式", { exact: true }).waitFor();
    await page.waitForURL(`${fixture.url}/albums/fixture-album`);
    await page.waitForLoadState("networkidle");
    pass("album-specific first action opens its upload/verification panel and clears action query");

    await page.getByRole("button", { name: "进入管理模式", exact: true }).click();
    const uploader = page.locator(".album-photo-uploader");
    await uploader.waitFor();
    for (const [index, file] of [
      { name: "local-pair.png", type: "image/png" },
      { name: "local-pair.avif", type: "image/avif" },
    ].entries()) {
      const zone = uploader.locator(".album-drop-zone").nth(index);
      await zone.evaluate((element, file) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["selection-only fixture"], file.name, { type: file.type }));
        for (const type of ["dragenter", "dragover", "drop"]) {
          element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        }
      }, file);
      await zone.getByText("已选择 1 个文件", { exact: true }).waitFor();
      await uploader.getByText(file.name, { exact: true }).waitFor();
      await page.waitForLoadState("networkidle");
      assert.equal(page.url(), `${fixture.url}/albums/fixture-album`);
      assert.equal(await page.locator(".author-drop-layer").count(), 0);
    }
    await uploader.getByRole("heading", { name: "1 张 SDR · 1 组 HDR", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "上传照片", exact: true }).count(), 0);
    assert.equal(fixture.collections.album_photos.length, 0, "Dropping files must not submit an upload.");
    await page.screenshot({ path: path.join(fixture.output, "local-album-drop.png") });
    pass("local SDR/HDR drop zones retain the current album and paired files without global navigation");

    for (const entry of [
      { name: "dropped-master.mp4", type: "video/mp4", url: "/upload", content: "video selection fixture" },
      { name: "dropped-photo.png", type: "image/png", url: "/albums?dialog=upload", content: "photo selection fixture" },
      { name: "dropped-film.tiff", type: "image/tiff", url: "/albums?dialog=film", content: "film selection fixture" },
      { name: "dropped-article.md", type: "text/markdown", url: "/write", content: "# 拖放验收文章\n\n完整正文保留。" },
    ]) {
      const dropPage = await context.newPage();
      await dropPage.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });
      await dropPage.getByRole("button", { name: "工具", exact: true }).click();
      await dropPage.getByRole("button", { name: "退出", exact: true }).waitFor();
      await dropPage.keyboard.press("Escape");
      await dropPage.evaluate(entry => {
        const transfer = new DataTransfer(); transfer.items.add(new File([entry.content], entry.name, { type: entry.type }));
        document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
        document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }, entry);
      await dropPage.waitForURL(`${fixture.url}${entry.url}`);
      if (entry.url === "/write") {
        await dropPage.waitForFunction(() => document.querySelector("#article-content")?.value.includes("完整正文保留"));
      } else await dropPage.getByText(entry.name, { exact: false }).first().waitFor();
      await dropPage.waitForLoadState("networkidle");
      await dropPage.screenshot({ path: path.join(fixture.output, `drop-${entry.name.split(".").pop()}.png`) });
      await dropPage.close();
    }
    pass("video/photo/TIFF/Markdown drops retain files across client navigation without uploading");
    await page.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(["invalid"], "unknown.xyz"));
      document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    });
    await page.locator(".author-menu .create-menu-notice").filter({ hasText: /./ }).waitFor();
    await page.locator('.site-header a[href="/posts"]').click();
    await page.waitForURL(`${fixture.url}/posts`);
    await page.waitForLoadState("networkidle");
    await tools.click();
    assert.equal(await menu.locator(".create-menu-notice").innerText(), "");
    await page.keyboard.press("Escape");
    await page.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });

    const signedStatus = await (await context.request.get(`${fixture.url}/api/author/session`)).json();
    const csrfHeaders = { Origin: fixture.url, "X-Author-CSRF": signedStatus.csrf };
    assert.equal(signedStatus.article, true);
    assert.equal((await context.request.get(`${fixture.url}/api/albums/manage`)).status(), 403);
    assert.equal((await context.request.get(`${fixture.url}/api/albums/manage`, { headers: csrfHeaders })).status(), 200);
    assert.equal((await context.request.get(`${fixture.url}/api/albums/manage`, { headers: { Authorization: `Bearer ${fixture.token}` } })).status(), 200);
    assert.equal((await context.request.get(`${fixture.url}/api/albums/manage`, { headers: { ...csrfHeaders, Authorization: "Bearer wrong" } })).status(), 401);
    assert.equal((await context.request.post(`${fixture.url}/api/maintenance`, { headers: csrfHeaders, data: { enabled: true } })).status(), 401);

    await page.goto(`${fixture.url}/albums?dialog=create`, { waitUntil: "networkidle" });
    const createDialog = page.getByRole("dialog", { name: "新建相簿", exact: true });
    await createDialog.getByText("已作为作者登录", { exact: true }).waitFor();
    await createDialog.getByLabel("标题", { exact: true }).fill("Session album");
    const [created] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/api/albums") && response.request().method() === "POST"),
      createDialog.getByRole("button", { name: "创建并发布", exact: true }).click(),
    ]);
    assert.equal(created.status(), 201, await created.text());
    await createDialog.waitFor({ state: "hidden" }); await page.waitForURL(`${fixture.url}/albums`); await page.waitForLoadState("networkidle");

    await page.goto(`${fixture.url}/albums?dialog=upload`, { waitUntil: "networkidle" });
    const photoDialog = page.getByRole("dialog", { name: "上传照片", exact: true });
    const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#777777" } }).png().toBuffer();
    await photoDialog.locator('.album-drop-zone input[type="file"]').first().setInputFiles({ name: "session-photo.png", mimeType: "image/png", buffer: png });
    const [photoResponse] = await Promise.all([
      page.waitForResponse(response => /\/api\/albums\/\d+\/photos$/.test(response.url()) && response.request().method() === "POST"),
      photoDialog.getByRole("button", { name: "验证并上传整批照片", exact: true }).click(),
    ]);
    assert.equal(photoResponse.status(), 201, await photoResponse.text());
    await photoDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.waitForURL(`${fixture.url}/albums`); await page.waitForLoadState("networkidle");
    pass("session creates albums/uploads real PNGs; Bearer remains valid, manual errors do not fall back, maintenance stays token-only");

    await page.goto(`${fixture.url}/upload`, { waitUntil: "networkidle" });
    await page.getByText("已作为作者登录", { exact: true }).waitFor();
    await page.getByLabel("标题", { exact: true }).fill("Session video");
    await page.locator('.file-drop-zone input[type="file"]').first().setInputFiles(videoPath);
    await page.locator('.upload-actions button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector(".upload-status")?.textContent?.includes("上传完成，服务器已检测到元数据。")
      || document.querySelector(".upload-status.error"), null, { timeout: 90_000 });
    assert.match(await page.locator(".upload-status").innerText(), /上传完成，服务器已检测到元数据。/);
    assert.equal(fixture.collections.video_masters.length, 1);
    pass("session video upload uses real chunk transfer and FFmpeg verification without a pasted token");
    await page.goto(`${fixture.url}/write`, { waitUntil: "networkidle" });
    await page.getByText("已作为作者登录", { exact: true }).waitFor();
    await page.locator("#article-title").fill("Session draft");
    await page.locator("#article-content").fill("# 会话草稿\n\n真实请求保存。");
    const [savedArticle] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/api/articles") && response.request().method() === "POST"),
      page.getByRole("button", { name: /^保存草稿/ }).click(),
    ]);
    assert.equal(savedArticle.status(), 201, await savedArticle.text());
    await page.getByText("草稿已上传，Directus 已完成资源处理。", { exact: true }).waitFor();
    pass("article fallback authority saves a real draft with session and CSRF");
    await page.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });

    const albumTest = await promisify(execFile)("npm", ["run", "test:album-api"], {
      env: { ...process.env, ALBUM_API_ENV_FILE: fixture.envFile }, timeout: 90_000,
    });
    await fs.writeFile(path.join(fixture.output, "album-api.log"), albumTest.stdout + albumTest.stderr);
    pass("documented Bearer album API regression uses disposable CMS/media and enforces private draft thumbnails");

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });
    assert.equal(await otherPage.getByRole("button", { name: "工具", exact: true }).count(), 0);
    const sibling = await context.newPage();
    await sibling.goto(`${fixture.url}/posts`, { waitUntil: "networkidle" });
    await sibling.getByRole("button", { name: "工具", exact: true }).click();
    await sibling.getByRole("button", { name: "退出", exact: true }).waitFor();
    await sibling.getByRole("button", { name: "退出", exact: true }).click();
    await page.bringToFront();
    if (await tools.getAttribute("aria-expanded") !== "true") await tools.click();
    await menu.getByRole("button", { name: "作者登录", exact: true }).waitFor();
    pass("independent context stays a guest; shared-cookie tabs synchronize logout");
    await sibling.close();

    await menu.getByRole("button", { name: "作者登录", exact: true }).click();
    await dialog.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const apiResponse = await context.request.get(`${fixture.url}/api/author/session`);
    assert.equal(apiResponse.headers()["cache-control"], "no-store");
    const status = await apiResponse.json(); assert.equal(status.author, true);
    for (const headers of [{ Origin: fixture.url }, { Origin: "http://attacker.invalid", "X-Author-CSRF": status.csrf }]) {
      assert.equal((await context.request.delete(`${fixture.url}/api/author/session`, { headers })).status(), 403);
    }
    await fixture.restartApi();
    await page.reload({ waitUntil: "networkidle" }); await tools.click();
    await menu.getByRole("button", { name: "作者登录", exact: true }).waitFor();
    assert.equal((await context.cookies()).some(cookie => cookie.name === "author_hint"), false);
    await context.addCookies([{ name: "author_hint", value: "1", url: fixture.url }]);
    await page.reload({ waitUntil: "networkidle" }); await tools.click();
    await menu.getByRole("button", { name: "作者登录", exact: true }).waitFor();
    assert.equal((await context.cookies()).some(cookie => cookie.name === "author_hint"), false);
    assert.equal((await context.cookies()).some(cookie => cookie.name === "author_device"), true);
    await menu.getByRole("button", { name: "上传视频", exact: true }).click();
    await dialog.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(`${fixture.url}/upload`);
    await page.getByText("已作为作者登录", { exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    await page.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });
    await tools.click();
    await menu.getByRole("button", { name: "退出", exact: true }).click();
    pass("CSRF/cross-origin rejection, persistent device hint and expired action continuation");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await menu.getByRole("button", { name: "作者登录", exact: true }).click();
    await dialog.waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(fixture.output, "login-mobile.png") });
    await dialog.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    pass("narrow viewport and keyboard dialog dismissal under reduced motion");

    // Exercise the real HTTP serializer, which must retain the login's five-minute budget.
    for (let i = 0; i < 10; i++) assert.equal((await context.request.post(`${fixture.url}/api/author/session`, {
      headers: { Origin: fixture.url }, data: { token: "wrong" },
    })).status(), 401);
    const limited = await context.request.post(`${fixture.url}/api/author/session`, { headers: { Origin: fixture.url }, data: { token: "wrong" } });
    assert.equal(limited.status(), 429); assert.ok(Number(limited.headers()["retry-after"]) > 240);
    assert.equal(limited.headers()["cache-control"], "no-store");
    pass("HTTP login rate limit preserves Retry-After and no-store headers");
    for (const articleToken of [fixture.token, "separate-article-fixture", "__REPLACE_WITH_RANDOM_ARTICLE_TOKEN__"]) {
      await fixture.restartApi({ ARTICLE_API_TOKEN: articleToken });
      const login = await context.request.post(`${fixture.url}/api/author/session`, { headers: { Origin: fixture.url }, data: { token: fixture.token } });
      const author = await login.json();
      assert.equal(author.article, false);
      const denied = await context.request.post(`${fixture.url}/api/articles`, { headers: { Origin: fixture.url, "X-Author-CSRF": author.csrf }, data: {} });
      assert.equal(denied.status(), articleToken.startsWith("__REPLACE") ? 503 : 401);
    }
    await page.goto(`${fixture.url}/write`, { waitUntil: "networkidle" });
    await page.getByPlaceholder("ARTICLE_API_TOKEN", { exact: true }).waitFor();
    assert.equal(await page.getByText("已作为作者登录", { exact: true }).count(), 0);
    pass("separate, same-valued explicit and placeholder article tokens never inherit author-session publication rights");
    assert.deepEqual(report.errors, []);
    report.passed = true;
    await other.close();
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
