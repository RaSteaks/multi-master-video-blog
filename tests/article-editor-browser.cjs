// Run against npm run dev:web; only local, unsaved Markdown is edited.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const output = path.resolve(__dirname, "../test-results/article-preview-scroll/browser");
const content = "# 文章预览滚动测试\n\n" + Array.from({ length: 28 }, (_, index) =>
  `## 第 ${index + 1} 节\n\n长文章应在预览区内滚动，编辑区和页面保持原位。\n\n- 检查内容完整可读\n- 检查上下滚动\n\n`,
).join("") + "## 文章结束\n\n预览底部已到达。";

async function main() {
  await fs.mkdir(output, { recursive: true });
  const report = { browser: "headless WebKit", status: "running", checks: [], errors: [] };
  const browser = await webkit.launch({
    headless: true,
    executablePath: process.env.WEBKIT_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => report.errors.push(error.message));
  try {
    // Wait for the local client bundle before editing server-rendered form fields.
    await page.goto(`${process.env.ARTICLE_EDITOR_BASE_URL || "http://127.0.0.1:3000"}/write`, { waitUntil: "networkidle" });
    // The textarea remains mounted but is hidden from the accessibility tree in preview mode.
    const editor = page.locator("#article-content");
    const preview = page.getByRole("region", { name: "文章预览", exact: true });
    await editor.fill(content);
    await preview.getByRole("heading", { name: "文章预览滚动测试", exact: true }).waitFor();

    const scenarios = [
      { name: "desktop-split", width: 1280, height: 900, mode: "分栏" },
      { name: "desktop-preview", width: 1280, height: 900, mode: "预览" },
      { name: "desktop-short", width: 761, height: 480, mode: "预览" },
      { name: "tablet-split", width: 700, height: 900, mode: "分栏" },
      { name: "tablet-preview", width: 760, height: 650, mode: "预览" },
      { name: "mobile-preview", width: 390, height: 844, mode: "预览" },
      { name: "mobile-short", width: 390, height: 520, mode: "预览", reducedMotion: true },
    ];

    for (const scenario of scenarios) {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.emulateMedia({ reducedMotion: scenario.reducedMotion ? "reduce" : "no-preference" });
      await page.getByRole("button", { name: scenario.mode, exact: true }).click();
      // Settle initial document positioning without its CSS smooth-scroll animation.
      // The assertions below use actual wheel/keyboard input inside the preview.
      await preview.evaluate(element => {
        element.focus({ preventScroll: true });
        element.scrollIntoView({ behavior: "instant", block: "center" });
        element.scrollTop = 0;
      });
      await preview.hover();
      const dimensions = await preview.evaluate(element => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        paneHeight: element.parentElement.clientHeight,
      }));
      assert.ok(dimensions.clientHeight > 0 && dimensions.clientHeight < dimensions.paneHeight,
        `${scenario.name}: preview fits below its pane label`);
      assert.ok(dimensions.scrollHeight > dimensions.clientHeight,
        `${scenario.name}: long Markdown must overflow the preview`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${scenario.name}: no horizontal page overflow`);

      const documentTop = await page.evaluate(() => scrollY);
      const editorTop = await editor.evaluate(element => element.scrollTop);
      await page.mouse.wheel(0, 420);
      await page.waitForFunction(() => document.querySelector('[aria-label="文章预览"]').scrollTop > 0);
      await settleScroll(preview);
      assert.equal(await page.evaluate(() => scrollY), documentTop, `${scenario.name}: wheel down stays inside preview`);
      const afterDown = await preview.evaluate(element => element.scrollTop);
      await page.mouse.wheel(0, -180);
      await page.waitForFunction(top => document.querySelector('[aria-label="文章预览"]').scrollTop < top, afterDown);
      await settleScroll(preview);
      assert.equal(await page.evaluate(() => scrollY), documentTop, `${scenario.name}: wheel up stays inside preview`);
      const afterUp = await preview.evaluate(element => element.scrollTop);
      await preview.press("PageDown");
      await page.waitForFunction(top => document.querySelector('[aria-label="文章预览"]').scrollTop > top, afterUp);
      await settleScroll(preview);
      assert.ok(await preview.evaluate(element => element === document.activeElement),
        `${scenario.name}: preview supports keyboard focus`);

      await page.mouse.wheel(0, 100_000);
      await page.waitForFunction(() => {
        const element = document.querySelector('[aria-label="文章预览"]');
        return Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1;
      });
      await settleScroll(preview);
      assert.ok(await preview.getByText("预览底部已到达。", { exact: true }).isVisible());
      await page.screenshot({ path: path.join(output, `${scenario.name}.png`) });
      await page.mouse.wheel(0, -100_000);
      await page.waitForFunction(() => document.querySelector('[aria-label="文章预览"]').scrollTop === 0);
      await settleScroll(preview);
      assert.equal(await page.evaluate(() => scrollY), documentTop, `${scenario.name}: document stays still`);
      assert.equal(await editor.evaluate(element => element.scrollTop), editorTop,
        `${scenario.name}: editor stays still`);
      assert.equal(await editor.inputValue(), content, `${scenario.name}: mode changes preserve Markdown`);
      report.checks.push({ name: scenario.name, ...dimensions, wheelDown: afterDown, wheelUp: afterUp });
    }

    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await editor.fill("# 短文\n\n只有一小段正文。");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await preview.getByRole("heading", { name: "短文", exact: true }).waitFor();
    assert.equal(await preview.evaluate(element => element.scrollHeight), await preview.evaluate(element => element.clientHeight));
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await editor.fill("");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await preview.getByText("预览区等待内容", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "mobile-empty.png") });
    report.checks.push({ name: "short-and-empty-preview", status: "passed" });
    assert.deepEqual(report.errors, []);
    report.status = "passed";
    console.log(`Passed ${report.checks.length} article editor browser scenarios (headless WebKit).`);
  } catch (error) {
    report.status = "failed";
    report.failure = error.message;
    await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
    throw error;
  } finally {
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    await browser.close();
  }
}

async function settleScroll(preview) {
  // Native keyboard/wheel scrolling can keep animating after the first scroll event.
  await preview.evaluate(element => new Promise(resolve => {
    let previous = element.scrollTop;
    let stableFrames = 0;
    function check() {
      stableFrames = element.scrollTop === previous ? stableFrames + 1 : 0;
      previous = element.scrollTop;
      if (stableFrames >= 6) resolve();
      else requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
