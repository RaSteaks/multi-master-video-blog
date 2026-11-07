const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit } = require("playwright");
const sharp = require("sharp");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  const output = path.join(__dirname, "../test-results/asset-cache");
  await fs.mkdir(output, { recursive: true });
  const report = { passed: false, checks: [], imageRequests: [] };
  const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  let fixture, browser;
  try {
    // Dedicated production build, CMS/media fixtures and browser context; no personal services/data.
    fixture = await startFixture({ name: "asset-cache", cmsPort: 18119, apiPort: 18124, webPort: 13114, production: true });
    const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#25636a" } }).png().toBuffer();
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "cache-fixture.png");
    const upload = await fetch(`${fixture.cmsUrl}/files`, { method: "POST", body: form });
    assert.equal(upload.status, 200);
    const fileId = (await upload.json()).data.id;
    const file = fixture.collections.files.find(item => item.id === fileId);
    Object.assign(file, { modified_on: "2026-11-07T00:00:00.001Z", uploaded_on: "2026-11-07T00:00:00Z" });
    const post = fixture.collections.posts[0];
    post.cover_image = fileId;
    post.content = `# 图片缓存验证\n\n![缓存验证图片](/api/assets/${fileId})\n\n公开图片仍须验证发布状态。`;
    const assetPath = `/api/assets/${fileId}`;
    const assetUrl = `${fixture.url}${assetPath}`;
    browser = await webkit.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", async response => {
      if (response.url() !== assetUrl) return;
      report.imageRequests.push({ status: response.status(), cache: response.headers()["x-asset-cache"],
        conditional: response.request().headers()["if-none-match"] || null });
    });
    await page.goto(`${fixture.url}/posts/fixture-post`, { waitUntil: "networkidle" });
    const img = page.locator(`img[src="${assetPath}"]`);
    await img.waitFor();
    await page.waitForFunction(src => [...document.images].some(image => image.getAttribute("src") === src && image.complete && image.naturalWidth > 0), assetPath);
    assert.equal(report.imageRequests[0].cache, "MISS");
    await page.screenshot({ path: path.join(output, "article-cached-image.png"), fullPage: true });
    pass("production page streams and displays the first image");

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(src => [...document.images].some(image => image.getAttribute("src") === src && image.complete && image.naturalWidth > 0), assetPath);
    assert.ok(report.imageRequests.some(request => request.conditional?.startsWith('W/"asset-') && request.cache === "REVALIDATED"));
    assert.deepEqual(errors, []);
    pass("WebKit reload revalidates ETag and displays the browser-cached image without an origin image read");

    // Cache algorithms and HTTP boundaries live in the API unit suite. Keep this
    // browser check focused on native revalidation and revocation through Next.
    const etag = report.imageRequests.find(request => request.conditional)?.conditional;
    assert.ok(etag);
    post.published = false;
    for (const method of ["GET", "HEAD"]) {
      const revoked = await fetch(assetUrl, { method, headers: { "If-None-Match": etag } });
      assert.equal(revoked.status, 404);
      assert.match(revoked.headers.get("cache-control"), /no-store/);
      await revoked.text();
    }
    const preview = await fetch(assetUrl, { headers: { Authorization: `Bearer ${fixture.token}` } });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("x-asset-cache"), "BYPASS");
    assert.equal(preview.headers.get("cache-control"), "private, no-store");
    assert.match(preview.headers.get("vary"), /X-Author-CSRF/);
    await preview.arrayBuffer();
    pass("unpublishing revokes cached GET/HEAD while authorized previews remain private and uncached");
    report.passed = true;
  } catch (error) { report.error = error.stack; throw error; }
  finally {
    await fs.writeFile(path.join(output, "browser-report.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    await fixture?.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
