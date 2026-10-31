const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

const ROUTES = ["/videos", "/posts", "/albums", "/project"];

// Geometry the route wipe depends on: anything that differs here jumps as the divider passes.
const measure = page => page.evaluate(() => {
  const rect = element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top + scrollY, width: box.width, height: box.height };
  };
  const title = document.querySelector("main h1");
  const content = document.querySelector("main .content-grid, main .empty-state");
  const card = document.querySelector("main .content-card");
  const titleStyle = getComputedStyle(title);
  return {
    head: { ...rect(title), width: 0, height: 0, size: titleStyle.fontSize, weight: titleStyle.fontWeight,
      eyebrow: Boolean(document.querySelector("main .eyebrow")), contentTop: rect(content).top, gap: getComputedStyle(content).columnGap },
    card: card ? { ...rect(card), radius: getComputedStyle(card).borderTopLeftRadius, border: getComputedStyle(card).borderTopWidth,
      media: rect(card.querySelector(".content-card-media")) } : null,
    overflow: document.documentElement.scrollWidth > innerWidth,
  };
});

async function main() {
  const fixture = await startFixture({ name: "list-pages", cmsPort: 18071, apiPort: 18076, webPort: 13011 });
  const pass = name => console.log(`PASS ${name}`);
  const exhibit = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>exhibit</title><body style='background:#123'>exhibit</body>");
  });
  let browser;
  const errors = [];
  try {
    await new Promise((resolve, reject) => { exhibit.once("error", reject); exhibit.listen(18078, "127.0.0.1", resolve); });
    fixture.collections.external_projects.push({ id: 1, title: "光线实验", description: "验证卡片外框", url: "http://127.0.0.1:18078/site",
      preview_url: null, preview_enabled: true, open_mode: "iframe", cover_image: null, published: true, sort_order: 1 });
    fixture.collections.video_projects.push({ id: 1, title: "验收视频", slug: "fixture-video", published: true, masters: [] });
    browser = await webkit.launch({ headless: true, executablePath: process.env.WEBKIT_EXECUTABLE || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));

    for (const [width, height] of [[1280, 900], [800, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const measured = {};
      for (const route of ROUTES) {
        await page.goto(`${fixture.url}${route}`, { waitUntil: "networkidle" });
        measured[route] = await measure(page);
        assert.equal(measured[route].overflow, false, `${route} overflows at ${width}px`);
      }
      for (const route of ROUTES.slice(1)) assert.deepEqual(measured[route].head, measured["/videos"].head, `${route} head at ${width}px`);
      assert.deepEqual(measured["/project"].card, measured["/albums"].card, `album and laboratory cards at ${width}px`);
      await page.screenshot({ path: path.join(fixture.output, `list-${width}.png`) });
    }
    pass("all list pages share one page head and content start; album and laboratory cards coincide at every width");

    await page.setViewportSize({ width: 1280, height: 900 });
    const nav = page.getByRole("navigation", { name: "主要导航" });
    await page.goto(`${fixture.url}/videos`, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter), "stable");
    await page.locator(".liquid-bg").evaluate(element => { element.dataset.survives = "true"; });
    for (const [label, route] of [["相簿", "/albums"], ["文章", "/posts"], ["实验室", "/project"]]) {
      await nav.getByRole("link", { name: label, exact: true }).click();
      await page.waitForURL(`${fixture.url}${route}`);
      await page.waitForFunction(() => !document.documentElement.dataset.vtDirection);
      assert.equal(await page.locator(".liquid-bg").count(), 1);
      assert.equal(await page.locator('.liquid-bg[data-survives="true"]').count(), 1, `background restarted on ${route}`);
    }
    await page.getByRole("button", { name: "查看光线实验", exact: true }).waitFor();
    pass("the liquid background is one instance that survives section changes");

    await nav.getByRole("link", { name: "相簿", exact: true }).click();
    await page.waitForURL(`${fixture.url}/albums`);
    await page.waitForFunction(() => !document.documentElement.dataset.vtDirection);
    await nav.getByRole("link", { name: "实验室", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.vtDirection && document.querySelector("[data-preview-id]"));
    await page.waitForTimeout(500);
    const during = await page.evaluate(() => ({ wiping: Boolean(document.documentElement.dataset.vtDirection), frames: document.querySelectorAll("main iframe").length }));
    assert.deepEqual(during, { wiping: true, frames: 0 });
    await page.waitForFunction(() => !document.documentElement.dataset.vtDirection);
    await page.locator("main iframe").waitFor();
    pass("a preview waits for the route wipe to finish before it loads");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => exhibit.close(resolve));
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
