const assert = require("node:assert/strict");
const http = require("node:http");
const playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

const ENGINE = process.env.SORT_ENGINE || "webkit";

async function main() {
  const fixture = await startFixture({ name: `sort-${ENGINE}`, cmsPort: 18181, apiPort: 18186, webPort: 13071 });
  const pass = name => console.log(`PASS ${name}`);
  const exhibit = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>exhibit</title><body style='background:#123'>exhibit</body>");
  });
  let browser;
  const errors = [];
  try {
    await new Promise((resolve, reject) => { exhibit.once("error", reject); exhibit.listen(18188, "127.0.0.1", resolve); });
    const { posts, video_projects: videos, albums, external_projects: projects } = fixture.collections;
    posts[0].title = "文章一";
    for (const [id, title, published] of [[2, "文章二", true], [3, "文章三", true], [4, "文章草稿", false], [5, "文章四", true], [6, "文章五", true]]) {
      posts.push({ ...posts[0], id, title, slug: `post-${id}`, published });
    }
    for (const id of [1, 2, 3]) videos.push({ id, title: `视频${id}`, slug: `video-${id}`, published: true, sort_order: 0, masters: [], created_at: `2026-01-0${id}T00:00:00Z` });
    for (const id of [2, 3]) albums.push({ ...albums[0], id, title: `相簿${id}`, slug: `album-${id}`, created_at: `2026-0${id}-01T00:00:00Z` });
    for (const id of [1, 2, 3]) {
      projects.push({ id, title: `网站${id}`, url: `http://127.0.0.1:18188/site${id}`, preview_url: null, open_mode: "iframe", preview_enabled: true,
        cover_image: null, published: true, sort_order: 0, created_at: `2026-01-0${id}T00:00:00Z` });
    }

    browser = await playwright[ENGINE].launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    // A React warning such as a missing key arrives here, not as a page error.
    page.on("console", message => { if (message.type() === "error" && !/^Failed to load resource/.test(message.text())) errors.push(message.text()); });
    const saves = [];
    page.on("request", request => {
      if (request.url().includes("/api/content-order/")) saves.push({ section: request.url().split("/").pop(), ids: JSON.parse(request.postData()).ids });
    });
    const handles = page.locator(".sort-handle");
    const titles = () => page.locator("main .content-grid > li h2").allTextContents();
    const stored = rows => [...rows].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || b.id - a.id).map(row => row.title);
    const handleOf = title => page.locator("main .content-grid > li", { hasText: title }).locator(".sort-handle");
    const centre = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
    const grab = async title => {
      const point = await centre(handleOf(title));
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      return point;
    };
    // The grabbed handle must end up over the target's handle, so travel by the distance between them.
    const dragOnto = async (title, target) => {
      const from = await grab(title);
      const to = await centre(handleOf(target));
      await page.mouse.move(from.x + (to.x - from.x) / 2, from.y + (to.y - from.y) / 2, { steps: 6 });
      await page.mouse.move(to.x, to.y, { steps: 6 });
      await page.waitForTimeout(60);
      return to;
    };
    const saved = async count => {
      await page.waitForFunction(() => document.querySelector("main p.visually-hidden[role=status]")?.textContent === "顺序已保存");
      assert.equal(saves.length, count);
    };

    await page.goto(`${fixture.url}/posts`, { waitUntil: "networkidle" });
    assert.deepEqual(await titles(), ["文章五", "文章四", "文章三", "文章二", "文章一"], "An unarranged list keeps its newest-first order.");
    assert.equal(await handles.count(), 0);
    assert.equal((await context.request.patch(`${fixture.url}/api/content-order/posts`, { data: { ids: [1, 2] } })).status(), 401);
    pass("visitors see no handles and cannot arrange");

    await page.keyboard.press("Control+Alt+Shift+L");
    const login = page.getByRole("dialog", { name: "作者登录", exact: true });
    await login.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await login.waitFor({ state: "hidden" });
    await handles.first().waitFor();
    assert.equal(await handles.count(), 5);
    const chip = await handles.first().boundingBox();
    const firstCard = await page.locator(".content-card").first().boundingBox();
    assert.ok(Math.abs(firstCard.x + firstCard.width - (chip.x + chip.width) - 10) < 1 && Math.abs(chip.y - firstCard.y - 10) < 1, "The handle sits in the card's top right corner.");
    assert.equal(await page.locator(".content-card .sort-handle, a .sort-handle").count(), 0, "The handle is not nested in the card's link.");
    await handles.first().click();
    await page.waitForTimeout(150);
    assert.equal(new URL(page.url()).pathname, "/posts");
    assert.equal(saves.length, 0, "Clicking a handle does nothing.");
    pass("an author gets a handle on every card, and clicking it neither navigates nor saves");

    const before = await page.locator("main .content-grid > li").first().boundingBox();
    const domOrder = () => page.locator("main .content-grid > li").evaluateAll(cards => cards.map(card => card.dataset.sortId));
    const domBefore = await domOrder();
    const start = await grab("文章五");
    await page.mouse.move(start.x + 30, start.y + 20, { steps: 3 });
    await page.waitForTimeout(40);
    const lifted = await page.locator("li[data-dragging] .content-card").boundingBox();
    assert.ok(Math.abs(lifted.x - before.x - 30) < 2 && Math.abs(lifted.y - before.y - 20) < 2, `The card follows the pointer, got ${lifted.x - before.x},${lifted.y - before.y}.`);
    const slot = await page.locator("li[data-dragging]").boundingBox();
    assert.ok(Math.abs(slot.x - before.x) < 1, "The slot stays behind.");
    assert.match(await page.locator("li[data-dragging]").evaluate(card => getComputedStyle(card).outlineStyle), /dashed/);
    const target = await centre(handleOf("文章三"));
    await page.mouse.move(target.x, target.y, { steps: 10 });
    await page.waitForTimeout(350);
    assert.deepEqual(await domOrder(), domBefore, "The DOM holds still during a drag.");
    const slotAfter = await page.locator("li[data-dragging]").boundingBox();
    assert.ok(slotAfter.x > slot.x + 300, `Other cards make way, slot at ${slotAfter.x}.`);
    await page.mouse.up();
    await saved(1);
    assert.deepEqual(await titles(), ["文章四", "文章三", "文章五", "文章二", "文章一"]);
    assert.deepEqual(saves[0], { section: "posts", ids: [5, 3, 6, 2, 1] });
    assert.equal(await page.locator("li[data-dragging]").count(), 0);
    pass("dragging a card by its handle lifts it over a dashed slot, makes way live and saves on drop");

    assert.deepEqual(stored(posts), ["文章四", "文章三", "文章草稿", "文章五", "文章二", "文章一"], "The draft keeps its slot, third of six.");
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(`${fixture.url}/posts`, { waitUntil: "networkidle" });
    assert.deepEqual(await visitor.locator("main .content-grid > li h2").allTextContents(), ["文章四", "文章三", "文章五", "文章二", "文章一"], "Visitors see the arrangement.");
    assert.equal(await visitor.locator(".sort-handle").count(), 0);
    await visitor.context().close();
    pass("the arrangement reaches visitors and leaves the draft in its slot");

    await dragOnto("文章四", "文章五");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await page.mouse.up();
    assert.deepEqual(await titles(), ["文章四", "文章三", "文章五", "文章二", "文章一"], "Escape puts everything back.");
    assert.equal(saves.length, 1);
    pass("Escape cancels a drag without saving");

    const keyed = handleOf("文章三");
    await keyed.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    assert.deepEqual(await titles(), ["文章四", "文章五", "文章二", "文章一", "文章三"]);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "调整“文章三”的顺序，使用方向键移动", "Focus stays on the handle.");
    assert.match(await page.locator("main p.visually-hidden[role=status]").textContent(), /“文章三”已移到第 5 位，共 5 项/);
    await page.keyboard.press("Home");
    await saved(2);
    assert.deepEqual((await titles()).slice(0, 2), ["文章三", "文章四"]);
    pass("arrow keys and Home move a focused handle, announce it, and send one save");

    let refusing = true;
    await page.route("**/api/content-order/posts", route => (refusing ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "内容排序字段尚未安装，请先运行 npm run setup:cms-schema。" }) }) : route.continue()));
    const settled = await titles();
    await dragOnto(settled[0], settled[2]);
    await page.mouse.up();
    await page.getByRole("alert").filter({ hasText: "setup:cms-schema" }).waitFor();
    assert.match(await page.getByRole("alert").filter({ hasText: "setup:cms-schema" }).textContent(), /已恢复之前的顺序/);
    assert.deepEqual(await titles(), settled, "A failed save puts the last saved order back.");
    refusing = false;
    await page.unroute("**/api/content-order/posts");
    await page.route("**/api/content-order/posts", route => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ status: "error", error: "Not found" }) }));
    await dragOnto(settled[0], settled[2]);
    await page.mouse.up();
    await page.getByRole("alert").filter({ hasText: "重启或更新 API" }).waitFor();
    assert.equal(await page.getByRole("alert").filter({ hasText: "Not found" }).count(), 0, "An API too old for this site is named, not reported as a bare 404.");
    assert.deepEqual(await titles(), settled);
    await page.unroute("**/api/content-order/posts");
    pass("a failed save restores the last saved order and says why");

    saves.length = 0;
    for (const [route, section, label, first, last, rows] of [["/videos", "videos", "视频作品", "视频3", "视频1", videos], ["/albums", "albums", "相簿", "相簿3", "验收相簿", albums], ["/project", "projects", "网站作品", "网站3", "网站1", projects]]) {
      await page.goto(`${fixture.url}${route}`, { waitUntil: "networkidle" });
      await handles.first().waitFor();
      assert.equal(await page.getByRole("list", { name: label, exact: true }).count(), 1);
      if (route === "/albums") {
        const picture = await page.locator(".album-card-frame").first().boundingBox();
        const grip = await handles.first().boundingBox();
        assert.ok(grip.x + grip.width <= picture.x + picture.width && grip.y >= picture.y, "The album handle sits inside the picture, clear of the sprocket rail.");
      }
      await page.evaluate(() => { window.__sameDocument = true; });
      await dragOnto(first, last);
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector("main p.visually-hidden[role=status]")?.textContent === "顺序已保存");
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => window.__sameDocument), true, "Saving refreshes the data without reloading the page.");
      assert.equal(saves.at(-1).section, section);
      assert.equal((await titles()).at(-1), first, `${route} moved its card.`);
      assert.equal(stored(rows).at(-1), first, `${route} stored its order.`);
    }
    pass("videos, albums and the laboratory arrange the same way");

    await page.goto(`${fixture.url}/project`, { waitUntil: "networkidle" });
    await page.locator('ol[aria-label="网站作品"] iframe').nth(2).waitFor({ state: "attached" });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      window.__frames = [...document.querySelectorAll('ol[aria-label="网站作品"] iframe')];
      window.__reloads = 0;
      window.__frames.forEach(frame => frame.addEventListener("load", () => { window.__reloads++; }));
    });
    const labTitles = await titles();
    await dragOnto(labTitles[0], labTitles[1]);
    await page.waitForTimeout(200);
    assert.deepEqual(await page.evaluate(() => [window.__reloads, window.__frames.every(frame => frame.isConnected)]), [0, true], "Live frames keep running under a drag.");
    await page.mouse.up();
    await page.waitForTimeout(200);
    pass("a drag leaves laboratory live frames running");

    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto(`${fixture.url}/posts`, { waitUntil: "networkidle" });
    await handles.first().waitFor();
    const top = await titles();
    const from = await grab(top[0]);
    await page.mouse.move(from.x, 412, { steps: 4 });
    await page.waitForFunction(() => scrollY > 80, null, { timeout: 4000 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.setViewportSize({ width: 1280, height: 900 });
    pass("holding a card near the window edge scrolls the page");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${fixture.url}/posts`, { waitUntil: "networkidle" });
    await handles.first().waitFor();
    const calm = await titles();
    await dragOnto(calm[1], calm[0]);
    const glides = await page.evaluate(() => document.querySelector("main .content-grid").getAnimations({ subtree: true })
      .filter(animation => !(animation instanceof CSSTransition) && !(animation instanceof CSSAnimation)).length);
    assert.equal(glides, 0, "Reduced motion keeps cards from gliding.");
    await page.mouse.up();
    await page.waitForTimeout(200);
    assert.equal((await titles())[0], calm[1]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    pass("under reduced motion the card still follows the pointer and the others step aside");

    fixture.unmigratedCollections.add("posts");
    fixture.unmigratedCollections.add("albums");
    for (const [route, sample] of [["/posts", "文章一"], ["/albums", "验收相簿"]]) {
      await page.goto(`${fixture.url}${route}`, { waitUntil: "networkidle" });
      await page.locator("main .content-grid > li", { hasText: sample }).first().waitFor();
    }
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    assert.ok(await page.locator(".contact-frame").count() >= 5, "The home strip reads by date and never needed the field.");
    fixture.unmigratedCollections.clear();
    pass("a site deployed before its schema upgrade keeps every list up");

    if (ENGINE === "chromium") {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const mobile = await phone.newPage();
      await phone.addCookies((await context.cookies()).filter(cookie => cookie.name.startsWith("author")));
      await mobile.goto(`${fixture.url}/posts`, { waitUntil: "networkidle" });
      const grip = mobile.locator(".sort-handle");
      await grip.first().waitFor();
      const size = await grip.first().boundingBox();
      assert.ok(size.width >= 40 && size.height >= 40, `The touch target is ${size.width}px.`);
      assert.equal(await grip.first().evaluate(handle => getComputedStyle(handle).touchAction), "none");
      const order = await mobile.locator("main .content-grid > li h2").allTextContents();
      const cdp = await phone.newCDPSession(mobile);
      const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const a = await grip.nth(0).boundingBox();
      const b = await grip.nth(1).boundingBox();
      const x = a.x + a.width / 2;
      const y = a.y + a.height / 2;
      const scrolled = await mobile.evaluate(() => scrollY);
      await touch("touchStart", x, y);
      for (let step = 1; step <= 8; step++) {
        await touch("touchMove", x, y + (b.y - a.y) * step / 8);
        await mobile.waitForTimeout(30);
      }
      assert.equal(await mobile.evaluate(() => scrollY), scrolled, "Dragging the handle does not scroll the page.");
      await touch("touchEnd");
      await mobile.waitForTimeout(300);
      assert.deepEqual((await mobile.locator("main .content-grid > li h2").allTextContents()).slice(0, 2), [order[1], order[0]]);
      await phone.close();
      pass("a finger can drag a handle on a phone without scrolling the page");
    }

    // Article publishing can hold a separate token; arranging a list never needs it.
    await fixture.restartApi({ ARTICLE_API_TOKEN: "separate-article-token" });
    const separate = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await separate.goto(`${fixture.url}/posts`, { waitUntil: "networkidle" });
    await separate.keyboard.press("Control+Alt+Shift+L");
    const secondLogin = separate.getByRole("dialog", { name: "作者登录", exact: true });
    await secondLogin.getByLabel("上传令牌", { exact: true }).fill(fixture.token);
    await secondLogin.getByRole("button", { name: "登录", exact: true }).click();
    await secondLogin.waitFor({ state: "hidden" });
    await separate.locator(".sort-handle").first().waitFor();
    const session = await (await separate.context().request.get(`${fixture.url}/api/author/session`)).json();
    assert.equal(session.article, false, "This author cannot publish articles.");
    const firstHandle = separate.locator(".sort-handle").first();
    await firstHandle.focus();
    await separate.keyboard.press("ArrowRight");
    await separate.locator("main p.visually-hidden[role=status]", { hasText: "顺序已保存" }).waitFor();
    await separate.context().close();
    await fixture.restartApi({ ARTICLE_API_TOKEN: "" });
    pass("arranging articles needs an author session, not the separate publishing token");

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => exhibit.close(resolve));
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
