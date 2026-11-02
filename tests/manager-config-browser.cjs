const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startAuthFixture } = require("./helpers/manager-auth-fixture.cjs");

(async () => {
  const fixtures = [];
  let browser;
  try {
    browser = await webkit.launch({ headless: true });
    const pages = [];
    for (const value of ["source-secret", "target-secret"]) {
      const fixture = await startAuthFixture();
      fixtures.push(fixture);
      const dir = path.resolve(fixture.context.__dirname, "..");
      await fs.writeFile(path.join(dir, ".env"), "TOKEN=" + value + "\r\n");
      const page = await browser.newPage();
      pages.push(page);
      await page.goto(fixture.url + fixture.basePath);
      await page.locator("#username").fill("admin");
      await page.locator("#password").fill(fixture.password);
      await page.locator("#password").press("Enter");
      await page.locator("#backupPassword").fill("fixture backup passphrase");
    }
    const [source, target] = pages;
    const downloading = source.waitForEvent("download");
    await source.locator("#backupExport").click();
    const download = await downloading;
    const filename = await download.path();
    assert.ok(!(await fs.readFile(filename, "utf8")).includes("source-secret"));
    await target.locator("#backupFile").setInputFiles(filename);
    target.on("dialog", dialog => dialog.accept());
    const file = path.resolve(fixtures[1].context.__dirname, "../.env");
    await target.locator("#backupPassword").fill("incorrect password");
    await target.locator("#backupImport").click();
    await target.getByText("Incorrect backup password or damaged backup.", { exact: true }).waitFor();
    assert.equal(await fs.readFile(file, "utf8"), "TOKEN=target-secret\r\n");
    await target.locator("#backupPassword").fill("fixture backup passphrase");
    await target.locator("#backupImport").click();
    await target.getByText(/^Imported: /).waitFor();
    assert.equal(await fs.readFile(file, "utf8"), "TOKEN=source-secret\r\n");
    const output = path.resolve("test-results/manager-config");
    await fs.mkdir(output, { recursive: true });
    await target.locator('section[aria-label="Configuration backup"]').screenshot({ path: path.join(output, "import.png") });
    console.log("PASS encrypted export, rejected incorrect password and cross-server import in headless WebKit");
  } finally {
    await browser?.close();
    await Promise.all(fixtures.map(fixture => fixture.close()));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
