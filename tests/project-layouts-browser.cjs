const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { webkit, firefox } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  const engine = process.env.PROJECT_BROWSER === "firefox" ? firefox : webkit;
  const fixture = await startFixture({ name: `project-layouts-${engine.name()}`, cmsPort: 18127, apiPort: 18126, webPort: 13016 });
  const report = { browser: `headless ${engine.name()}`, checks: [], errors: [], passed: false };
  const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };
  const exhibit = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><style>body{margin:0;background:#171d27;color:#dce5ef;font:32px system-ui;display:grid;place-items:center;height:100vh}.shape{width:45vw;height:28vw;background:linear-gradient(130deg,#426674,#b3b19b);border-radius:50%}</style></head><body><div class="shape"></div><p>隔离网站预览 ${req.url}</p></body></html>`);
  });
  let browser, author, visitor;
  try {
    await new Promise((resolve, reject) => { exhibit.once("error", reject); exhibit.listen(18128, "127.0.0.1", resolve); });
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    const publicContext = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    author = await context.newPage(); visitor = await publicContext.newPage();
    for (const page of [author, visitor]) page.on("pageerror", error => report.errors.push(error.message));
    const login = await context.request.post(`${fixture.url}/api/author/session`, { headers: { Origin: fixture.url }, data: { token: fixture.token } });
    assert.equal(login.status(), 200);
    const session = await (await context.request.get(`${fixture.url}/api/author/session`)).json();
    const headers = { Origin: fixture.url, "X-Author-CSRF": session.csrf };
    const layoutEndpoint = `${fixture.url}/api/external-projects/layout`;
    assert.equal((await publicContext.request.patch(layoutEndpoint, { data: { layout: "dual" } })).status(), 401);
    assert.equal((await context.request.patch(layoutEndpoint, { data: { layout: "dual" } })).status(), 403);
    assert.equal((await context.request.patch(layoutEndpoint, { headers, data: { layout: "unknown" } })).status(), 400);
    assert.deepEqual(await (await publicContext.request.get(layoutEndpoint)).json(), { layout: "grid" });
    pass("layout read is public; writes require author session, CSRF and a valid template");

    await visitor.goto(`${fixture.url}/project`, { waitUntil: "networkidle" });
    await visitor.getByRole("heading", { name: "作品整理中" }).waitFor();
    const titles = ["光谱观察器", "胶片工作台", "色彩体积", "空间影像", "日常切片", "声音切面"];
    const groups = ["光与颜色", "影像与记录", "光与颜色", "空间与声音", "影像与记录", ""];
    const ids = [];
    for (let i = 0; i < titles.length; i++) {
      const response = await context.request.post(`${fixture.url}/api/external-projects`, { headers, data: {
        title: titles[i], description: i === 2 ? "颜色与空间的观察。".repeat(20) : "用于展示网站与页面的隔离实验。",
        url: `http://127.0.0.1:18128/${i}`, published: true, sort_order: i + 1, group_name: groups[i],
        open_mode: i === 5 ? "external" : "iframe",
      } });
      assert.equal(response.status(), 201); ids.push((await response.json()).project.id);
    }
    await context.request.post(`${fixture.url}/api/external-projects`, { headers, data: {
      title: "私有草稿", url: "http://127.0.0.1:18128/private", group_name: "私有分组", published: false, sort_order: 90,
    } });
    await author.goto(`${fixture.url}/project`, { waitUntil: "networkidle" });
    await author.getByRole("button", { name: "管理网站", exact: true }).click();
    const settings = author.getByRole("region", { name: "展示布局", exact: true });
    await settings.waitFor();
    await author.getByRole("button", { name: "管理私有草稿", exact: true }).waitFor();
    const selector = layout => settings.locator(`input[value="${layout}"]`);
    const publicLayout = () => visitor.locator("[data-project-layout]").getAttribute("data-project-layout");
    await selector("mosaic").check();
    await visitor.reload({ waitUntil: "networkidle" });
    assert.equal(await publicLayout(), "grid");
    assert.equal(await visitor.locator('[name="project-layout"]').count(), 0);
    await settings.getByRole("button", { name: "取消预览", exact: true }).click();
    assert.equal(await author.locator("[data-project-layout]").getAttribute("data-project-layout"), "grid");
    await selector("dual").check();
    await author.route("**/api/external-projects/layout", route => route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture unavailable"}' }) : route.continue());
    await settings.getByRole("button", { name: "保存布局", exact: true }).click();
    await settings.getByRole("alert").waitFor();
    assert.equal(await selector("dual").isChecked(), true);
    assert.deepEqual(await (await publicContext.request.get(layoutEndpoint)).json(), { layout: "grid" });
    await author.unroute("**/api/external-projects/layout");
    pass("unsaved previews stay author-local; cancel restores; failed saves preserve selection and public layout");

    for (const layout of ["catalogue", "mosaic", "alternating", "masonry", "groups", "dual"]) {
      await selector(layout).check();
      await settings.getByRole("button", { name: "保存布局", exact: true }).click();
      await author.getByText("布局已保存，访客下次访问或刷新时生效。", { exact: true }).waitFor();
      await author.waitForFunction(() => document.querySelector('section[aria-label="展示布局"] button[aria-busy="false"]:disabled') !== null);
      await visitor.goto(`${fixture.url}/project?layout=grid`, { waitUntil: "networkidle" });
      assert.equal(await publicLayout(), layout);
      assert.equal(await visitor.getByRole("region", { name: "展示布局", exact: true }).count(), 0);
      assert.equal(await visitor.getByText("私有草稿", { exact: true }).count(), 0);
      assert.equal(await visitor.getByRole("region", { name: "私有分组", exact: true }).count(), 0);
      assert.ok(await visitor.locator("[data-project-layout] iframe").count() <= 3);
      if (layout === "catalogue") {
        await visitor.getByRole("button", { name: "预览色彩体积", exact: true }).focus();
        const directoryScroll = await visitor.evaluate(() => scrollY);
        await visitor.keyboard.press("Enter");
        await visitor.getByRole("button", { name: "查看色彩体积", exact: true }).waitFor();
        assert.equal(await visitor.getByRole("button", { name: "预览色彩体积", exact: true }).evaluate(element => element === document.activeElement), true);
        assert.equal(await visitor.evaluate(() => scrollY), directoryScroll);
        await visitor.locator("#project-exhibit iframe").waitFor();
        assert.equal(await visitor.locator("#project-exhibit iframe").count(), 1);
        await visitor.getByRole("button", { name: "查看色彩体积", exact: true }).click();
        await visitor.getByRole("dialog", { name: "色彩体积", exact: true }).getByRole("button", { name: "← 返回实验室", exact: true }).click();
        assert.equal(await visitor.getByRole("button", { name: "查看色彩体积", exact: true }).evaluate(element => element === document.activeElement), true);
        await visitor.getByRole("button", { name: "预览声音切面", exact: true }).click();
        assert.equal(await visitor.getByRole("link", { name: "独立打开声音切面（新标签页）", exact: true }).getAttribute("target"), "_blank");
      } else {
        assert.equal(await visitor.locator("[data-project-layout] .content-card").count(), 6);
      }
      if (layout === "mosaic") {
        const first = await visitor.locator("[data-sort-id]").nth(0).boundingBox();
        const second = await visitor.locator("[data-sort-id]").nth(1).boundingBox();
        assert.ok(first.width > second.width * 1.7);
      }
      if (layout === "alternating") {
        const card = visitor.locator("[data-sort-id]").nth(1);
        assert.ok((await card.locator(".content-card-media").boundingBox()).x > (await card.locator(".content-card-copy").boundingBox()).x);
      }
      if (layout === "masonry") {
        await visitor.locator("[data-masonry]").waitFor();
        const boxes = await visitor.locator("[data-sort-id]").evaluateAll(items => items.map(item => {
          const r = item.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        }));
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          assert.ok(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1, "Masonry cards must not overlap.");
        }
      }
      if (layout === "groups") {
        assert.deepEqual(await visitor.locator("[data-project-layout] > section > h2").allTextContents(), ["光与颜色", "影像与记录", "空间与声音", "其他作品"]);
      }
      await visitor.screenshot({ path: path.join(fixture.output, `${layout}-desktop.png`), fullPage: true });
      await visitor.setViewportSize({ width: 390, height: 844 });
      await visitor.evaluate(() => scrollTo(0, 0));
      assert.equal(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await visitor.emulateMedia({ reducedMotion: "reduce" });
      await visitor.waitForFunction(() => !document.querySelector("[data-project-layout] iframe"));
      await visitor.screenshot({ path: path.join(fixture.output, `${layout}-mobile.png`), fullPage: true });
      await visitor.emulateMedia({ reducedMotion: "no-preference" });
      await visitor.setViewportSize({ width: 1280, height: 950 });
      pass(`${layout}: persists across sessions, public controls absent, responsive preview and reduced motion`);
    }

    await selector("mosaic").check();
    const previewHandle = author.getByRole("button", { name: `调整“${titles[0]}”的顺序，使用方向键移动`, exact: true });
    await previewHandle.focus(); await previewHandle.press("ArrowRight");
    await author.getByText("顺序已保存", { exact: true }).waitFor();
    await author.waitForLoadState("networkidle");
    assert.equal(await author.locator("[data-project-layout]").getAttribute("data-project-layout"), "mosaic");
    assert.deepEqual(await (await publicContext.request.get(layoutEndpoint)).json(), { layout: "dual" });
    pass("sorting refresh preserves an unsaved author layout preview after a previous layout save");

    await author.getByRole("button", { name: "管理声音切面", exact: true }).click();
    await author.getByRole("button", { name: "编辑网站", exact: true }).click();
    const editor = author.getByRole("dialog", { name: "编辑网站", exact: true });
    await editor.getByLabel("展示分组", { exact: true }).fill("空间与声音");
    await editor.getByRole("button", { name: "保存更改", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    await author.waitForLoadState("networkidle");
    const saved = await (await context.request.get(`${fixture.url}/api/external-projects/manage`, { headers })).json();
    assert.equal(saved.projects.find(project => project.id === ids[5]).group_name, "空间与声音");
    // The same sorter works against the real API inside a group and a masonry grid.
    for (const layout of ["masonry", "groups"]) {
      await selector(layout).check();
      const handle = author.getByRole("button", { name: `调整“${titles[0]}”的顺序，使用方向键移动`, exact: true });
      await handle.focus(); await handle.press(layout === "groups" ? "Home" : "End");
      await author.getByText("顺序已保存", { exact: true }).waitFor();
      await author.waitForLoadState("networkidle");
    }
    pass("project groups save through the real editor; keyboard reordering works in masonry and grouped layouts");

    await author.setViewportSize({ width: 1280, height: 1800 });
    for (const layout of ["mosaic", "masonry"]) {
      await selector(layout).check();
      const handles = author.locator(".sort-handle");
      await handles.first().scrollIntoViewIfNeeded();
      const firstId = await handles.first().evaluate(element => element.closest("li").dataset.sortId);
      const from = await handles.first().boundingBox();
      const to = await handles.nth(1).boundingBox();
      const response = author.waitForResponse(result => result.url().endsWith("/api/content-order/projects") && result.request().method() === "PATCH");
      await author.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await author.mouse.down();
      await author.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      await author.waitForFunction(() => document.querySelector('[data-dragging]')?.style.order === "1");
      await author.mouse.up();
      assert.equal((await response).status(), 200);
      await author.waitForLoadState("networkidle");
      assert.notEqual(await author.locator("[data-sort-id]").first().getAttribute("data-sort-id"), firstId);
    }
    await author.setViewportSize({ width: 1280, height: 950 });
    pass("pointer reordering commits in both wide/narrow mosaic and measured masonry grids");

    for (let i = 0; i < 20; i++) await context.request.post(`${fixture.url}/api/external-projects`, { headers, data: {
      title: `后续网站 ${i}`, url: `http://127.0.0.1:18128/extra-${i}`, sort_order: 100 + i, published: true, preview_enabled: false,
    } });
    await author.reload({ waitUntil: "networkidle" });
    await author.getByRole("button", { name: "加载更多", exact: true }).click();
    await author.waitForFunction(() => document.querySelectorAll("[data-sort-id]").length === 26);
    await author.getByRole("button", { name: "管理网站", exact: true }).click();
    await author.getByRole("button", { name: "加载更多", exact: true }).click();
    await author.waitForFunction(() => document.querySelectorAll("[data-sort-id]").length === 27);
    await selector("catalogue").check();
    await settings.getByRole("button", { name: "保存布局", exact: true }).click();
    await author.waitForFunction(() => document.querySelector('section[aria-label="展示布局"] button[aria-busy="false"]:disabled') !== null);
    assert.equal(await author.locator("[data-sort-id]").count(), 27);
    const finalId = fixture.collections.external_projects.at(-1).id;
    await visitor.goto(`${fixture.url}/project?project=${finalId}`, { waitUntil: "networkidle" });
    const deepViewer = visitor.getByRole("dialog", { name: "后续网站 19", exact: true });
    await deepViewer.waitFor();
    await deepViewer.getByRole("button", { name: "← 返回实验室", exact: true }).click();
    await visitor.getByRole("button", { name: "加载更多", exact: true }).click();
    await visitor.waitForFunction(() => document.querySelectorAll("[data-sort-id]").length === 26);
    assert.equal(await visitor.locator(`[data-sort-id="${finalId}"]`).count(), 1);
    pass("layout saving preserves loaded pages; catalogue deep links and pagination deduplicate later rows");

    // Reuse the pagination fixture: a full directory places the exhibit off-screen.
    await visitor.setViewportSize({ width: 390, height: 844 });
    await visitor.emulateMedia({ reducedMotion: "reduce" });
    const choice = visitor.getByRole("button", { name: `预览${titles[0]}`, exact: true });
    await choice.click();
    await choice.focus(); await choice.press("Enter");
    assert.equal(await visitor.locator("#project-exhibit .content-card").evaluate(element => element === document.activeElement), true);
    assert.equal(await visitor.locator("#project-exhibit h2").textContent(), titles[0]);
    const selectedCard = await visitor.locator("#project-exhibit .content-card").boundingBox();
    assert.ok(selectedCard.y >= 0 && selectedCard.y + selectedCard.height <= 844);
    await visitor.screenshot({ path: path.join(fixture.output, "catalogue-selection-mobile.png") });
    await visitor.setViewportSize({ width: 1280, height: 950 });
    await visitor.emulateMedia({ reducedMotion: "no-preference" });
    pass("long mobile catalogue selection reveals and focuses its card, including repeated keyboard selection");

    const publications = fixture.collections.external_projects.map(project => project.published);
    fixture.collections.external_projects.forEach(project => { project.published = false; });
    for (const layout of ["catalogue", "masonry", "groups"]) {
      await context.request.patch(layoutEndpoint, { headers, data: { layout } });
      await visitor.goto(`${fixture.url}/project`, { waitUntil: "networkidle" });
      await visitor.getByRole("heading", { name: "作品整理中" }).waitFor();
      assert.equal(await publicLayout(), layout);
      fixture.collections.external_projects[0].published = true;
      await visitor.reload({ waitUntil: "networkidle" });
      assert.equal(await visitor.locator("[data-project-layout] .content-card").count(), 1);
      assert.equal(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      fixture.collections.external_projects[0].published = false;
    }
    fixture.collections.external_projects.forEach((project, index) => { project.published = publications[index]; });
    pass("catalogue, flat and grouped renderers support empty and single-project collections");

    fixture.unavailableCollections.add("site_settings");
    await visitor.goto(`${fixture.url}/project`, { waitUntil: "networkidle" });
    assert.equal(await publicLayout(), "grid");
    assert.equal(await visitor.locator("[data-sort-id]").count(), 24);
    fixture.unavailableCollections.delete("site_settings");
    await context.request.delete(`${fixture.url}/api/author/session`, { headers });
    await author.reload({ waitUntil: "networkidle" });
    assert.equal(await author.getByRole("region", { name: "展示布局", exact: true }).count(), 0);
    assert.equal((await context.request.patch(layoutEndpoint, { headers, data: { layout: "grid" } })).status(), 401);
    pass("settings outage keeps public projects readable; expired authors lose layout controls and write authority");
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (author) await author.screenshot({ path: path.join(fixture.output, "failure-author.png"), fullPage: true }).catch(() => {});
    if (visitor) await visitor.screenshot({ path: path.join(fixture.output, "failure-visitor.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await fs.writeFile(path.join(fixture.output, "report.json"), JSON.stringify(report, null, 2));
    if (browser) await browser.close();
    exhibit.closeAllConnections(); await new Promise(resolve => exhibit.close(resolve));
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
