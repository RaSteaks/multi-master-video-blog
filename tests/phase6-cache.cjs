const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { webkit } = require("playwright");
const { spawn } = require("node:child_process");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "test-results/phase6-cache");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const fixture = await startFixture({ name: "phase6-cache", cmsPort: 18059, apiPort: 18064, webPort: 13004 });
  let server;
  const report = { checks: [], passed: false };
  const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  const env = { ...process.env, CMS_RUNTIME_ONLY: "false", DIRECTUS_URL: fixture.cmsUrl, NEXT_PUBLIC_DIRECTUS_URL: fixture.cmsUrl,
    DIRECTUS_EMAIL: "", DIRECTUS_PASSWORD: "", DIRECTUS_REVALIDATE: "1", API_INTERNAL_URL: fixture.apiUrl,
    SITE_HOME_COLLECTION_POST_LABEL: "文章计数", REVALIDATE_SECRET: "isolated-cache-fixture",
    NEXT_DIST_DIR: "../../test-results/phase6-cache/build", NEXT_TSCONFIG_PATH: "../../test-results/phase6-cache/tsconfig.json" };
  async function run(command, args, logName) {
    const log = await fs.open(path.join(output, logName), "w");
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", log.fd, log.fd] });
    await log.close();
    return child;
  }
  const origin = "http://127.0.0.1:13005";
  async function get() {
    const response = await fetch(origin, { signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200);
    return response.text();
  }
  async function invalidate(collection) {
    const response = await fetch(`${origin}/internal/revalidate`, { method: "POST", headers: { "Content-Type": "application/json", "x-revalidate-secret": env.REVALIDATE_SECRET }, body: JSON.stringify({ collection, event: "items.update", key: 1 }) });
    assert.equal(response.status, 200);
  }
  try {
    const build = await run("npm", ["run", "build:web"], "build.log");
    assert.equal(await new Promise(resolve => build.on("exit", resolve)), 0);
    const manifest = JSON.parse(await fs.readFile(path.join(output, "build/prerender-manifest.json"), "utf8"));
    assert.ok(manifest.routes["/"]);
    report.homepage = manifest.routes["/"];
    server = await run(process.execPath, ["node_modules/next/dist/bin/next", "start", "apps/web", "-H", "127.0.0.1", "-p", "13005"], "server.log");
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(origin)).ok) break; } catch { /* Production server starting. */ }
      await delay(200);
    }
    const initial = await get();
    assert.ok(initial.includes("<span>文章计数</span><strong>1</strong>"));
    pass("production homepage remains statically cached with real counts");

    for (const collection of ["posts", "video_projects", "albums"]) fixture.unavailableCollections.add(collection);
    for (const collection of ["posts", "video_projects", "albums"]) await invalidate(collection);
    await delay(1200);
    for (let i = 0; i < 8; i++) {
      const html = await get();
      assert.ok(html.includes("<span>文章计数</span><strong>1</strong>"));
      await delay(400);
    }
    assert.ok(fixture.failedReads.get("posts") > 0);
    pass("failed CMS revalidation keeps the last good counts instead of caching zeros");

    fixture.unavailableCollections.clear();
    fixture.collections.posts.push({ id: 2, slug: "cache-second", title: "Second", published: true, content: "text" });
    await invalidate("posts");
    let recovered = false;
    for (let i = 0; i < 30; i++) {
      const html = await get();
      if (html.includes("<span>文章计数</span><strong>2</strong>")) { recovered = true; break; }
      await delay(300);
    }
    assert.ok(recovered);
    pass("post webhook invalidation and recovered CMS refresh the cached homepage counts");
    await verifyInsecureClipboard(origin);
    pass("real insecure HTTP origin reports missing Clipboard API without an uncaught error");
    report.passed = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    if (server) { server.kill("SIGTERM"); await new Promise(resolve => server.once("exit", resolve)); }
    await fixture.close();
  }
}
// Use the production build: Next's development client is not part of the HTTP
// clipboard contract. The proxy keeps all traffic local without changing DNS or
// replacing browser globals, while the document has a real insecure origin.
async function verifyInsecureClipboard(origin) {
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url, "http://insecure.test");
    if (url.hostname !== "insecure.test") { res.writeHead(404); res.end(); return; }
    const upstream = http.request(`${origin}${url.pathname}${url.search}`, {
      method: req.method, headers: { ...req.headers, host: new URL(origin).host, origin, referer: origin },
    }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(13007, "127.0.0.1", resolve); });
    browser = await webkit.launch({ headless: true });
    const context = await browser.newContext({ proxy: { server: "http://127.0.0.1:13007" } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") console.log("HTTP browser:", message.text()); });
    await page.goto("http://insecure.test/posts/fixture-post", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector(".liquid-bg")?.dataset.liquidSpeed === "0.35");
    assert.equal(await page.evaluate(() => isSecureContext), false);
    assert.equal(await page.evaluate(() => navigator.clipboard), undefined);
    await page.getByRole("button", { name: "页面工具", exact: true }).click();
    await page.getByRole("button", { name: "复制本页链接", exact: true }).click();
    await page.getByText("复制失败，请从地址栏复制链接。", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "clipboard-fallback.png") });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
