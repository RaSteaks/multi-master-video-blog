// With --fixture the save check writes only to the disposable CMS. A supplied URL stays read-only.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const output = path.resolve(__dirname, "../test-results/article-preview-scroll/browser");
const content = "# 文章预览滚动测试\n\n" + Array.from({ length: 28 }, (_, index) =>
  `## 第 ${index + 1} 节\n\n在分栏中对照文章源码与排版。\n\n- 检查内容完整可读\n- 检查上下滚动\n\n`,
).join("") + "## 文章结束\n\n预览底部已到达。";

async function main(fixture) {
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
    await page.goto(`${fixture?.url || process.env.ARTICLE_EDITOR_BASE_URL || "http://127.0.0.1:3000"}/write`, { waitUntil: "networkidle" });
    // The textarea remains mounted but is hidden from the accessibility tree in preview mode.
    const editor = page.locator("#article-content");
    const preview = page.getByRole("region", { name: "文章预览", exact: true });

    const title = page.locator("#article-title");
    const slug = page.locator("#article-slug");
    const imported = "```sh\n# example\n```\n\n# Camera **Notes**\n\n正文";
    const file = { name: "camera.MARKDOWN", mimeType: "text/plain", buffer: Buffer.from("\uFEFF" + imported.replaceAll("\n", "\r\n")) };
    await chooseImport(page, "选择 Markdown 文件", file);
    await preview.getByRole("heading", { name: "Camera Notes" }).waitFor();
    assert.equal(await title.inputValue(), "Camera Notes");
    assert.equal(await slug.inputValue(), "camera-notes");
    assert.equal(await editor.inputValue(), imported);
    await editor.focus();
    await editor.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
    await page.keyboard.insertText("随输入更新");
    await preview.getByText("正文随输入更新", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^粗体/ }).click();
    await preview.locator("strong").filter({ hasText: "粗体文本" }).waitFor();
    report.checks.push({ name: "file-picker-title-and-live-preview", status: "passed" });

    const original = await editor.inputValue();
    for (const [name, buffer, error] of [
      ["image.txt", Buffer.from("正文"), "请选择 .md 或 .markdown 文件。"],
      ["empty.md", Buffer.from("\n "), "Markdown 文件没有正文，请选择其他文件。"],
      ["malformed.md", Buffer.from([0xff]), "Markdown 读取失败，请选择 UTF-8 编码的文本文件。"],
      ["large.md", Buffer.alloc(2 * 1024 * 1024 + 1), "Markdown 文件不能超过 2 MiB。"],
    ]) {
      await chooseImport(page, "选择 Markdown 文件", { name, mimeType: "text/plain", buffer });
      await page.getByText(error, { exact: true }).waitFor();
      assert.equal(await editor.inputValue(), original);
    }
    await chooseImport(page, "选择 Markdown 文件", file);
    const confirm = page.getByRole("dialog", { name: "替换当前正文？" });
    await confirm.getByRole("button", { name: "取消" }).click();
    assert.equal(await editor.inputValue(), original);
    await title.fill("手填标题");
    await slug.fill("custom-slug");
    await editor.evaluate(element => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["## 拖入的章节\n\n新的正文"], "dropped.md"));
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await confirm.getByRole("button", { name: "替换正文" }).click();
    await preview.getByRole("heading", { name: "拖入的章节" }).waitFor();
    assert.equal(await editor.inputValue(), "## 拖入的章节\n\n新的正文");
    assert.equal(await title.inputValue(), "手填标题");
    assert.equal(await slug.inputValue(), "custom-slug");
    report.checks.push({ name: "import-validation-cancel-and-local-drop", status: "passed" });

    await editor.fill("");
    await title.fill("");
    await chooseImport(page, "选择 Markdown 文件", {
      name: "拍摄手记.md", mimeType: "text/markdown",
      buffer: Buffer.from("## 雨后的街道\n\n傍晚的路面积着水，反射出招牌的颜色。\n\n- 固定白平衡\n- 保留灯光在水面的倒影"),
    });
    await preview.getByRole("heading", { name: "雨后的街道" }).waitFor();
    assert.equal(await title.inputValue(), "拍摄手记");
    assert.equal(await slug.inputValue(), "custom-slug");
    await page.getByRole("region", { name: "Markdown 正文", exact: true }).screenshot({
      path: path.join(output, "markdown-import.png"),
    });
    report.checks.push({ name: "filename-title-and-custom-slug", status: "passed" });

    await verifyWritingTools(page, editor, preview);
    report.checks.push({ name: "writing-tools-selection-and-rendering", status: "passed" });

    await editor.fill(content);
    await preview.getByRole("heading", { name: "文章预览滚动测试", exact: true }).waitFor();
    await editor.focus();
    await editor.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
    await preview.evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
    await settleScroll(preview);
    await preview.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await settleScroll(preview);
    await page.keyboard.insertText("\n\n## 补记\n\n长文末尾继续写作。");
    await preview.getByRole("heading", { name: "补记" }).waitFor();
    await settleScroll(editor);
    await assertScrollFollows(editor, preview);
    await editor.fill(content);
    report.checks.push({ name: "resume-typing-after-preview-scroll", status: "passed" });

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
      if (scenario.mode === "分栏") {
        await editor.evaluate(element => {
          element.scrollIntoView({ behavior: "instant", block: "center" });
          element.scrollTop = 0;
        });
        await editor.hover();
        await page.mouse.wheel(0, 640);
        await page.waitForFunction(() => document.querySelector("#article-content").scrollTop > 0);
        await settleScroll(editor);
        await assertScrollFollows(editor, preview);
        const top = await editor.evaluate(element => element.scrollTop);
        await page.mouse.wheel(0, -240);
        await page.waitForFunction(top => document.querySelector("#article-content").scrollTop < top, top);
        await settleScroll(editor);
        await assertScrollFollows(editor, preview);
      }
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
      if (scenario.mode === "分栏") await assertScrollFollows(preview, editor);
      assert.equal(await page.evaluate(() => scrollY), documentTop, `${scenario.name}: wheel down stays inside preview`);
      const afterDown = await preview.evaluate(element => element.scrollTop);
      await page.mouse.wheel(0, -180);
      await page.waitForFunction(top => document.querySelector('[aria-label="文章预览"]').scrollTop < top, afterDown);
      await settleScroll(preview);
      if (scenario.mode === "分栏") await assertScrollFollows(preview, editor);
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
      if (scenario.mode === "分栏") await assertScrollFollows(preview, editor);
      assert.ok(await preview.getByText("预览底部已到达。", { exact: true }).isVisible());
      await page.screenshot({ path: path.join(output, `${scenario.name}.png`) });
      await page.mouse.wheel(0, -100_000);
      await page.waitForFunction(() => document.querySelector('[aria-label="文章预览"]').scrollTop === 0);
      await settleScroll(preview);
      assert.equal(await page.evaluate(() => scrollY), documentTop, `${scenario.name}: document stays still`);
      if (scenario.mode === "分栏") await assertScrollFollows(preview, editor);
      else assert.equal(await editor.evaluate(element => element.scrollTop), editorTop,
        `${scenario.name}: preview-only scrolling leaves the hidden editor alone`);
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

    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const fraction = String.raw`V=\frac{L^{1/2.4}-L_B^{1/2.4}}{L_W^{1/2.4}-L_B^{1/2.4}}`;
    const matrix = String.raw`\begin{bmatrix}1 & 0 \\ 0 & 1\end{bmatrix}`;
    const coefficients = String.raw`y'=0.2126R'+0.7152G'+0.0722B',\qquad c_b=\frac{B'-y'}{2(1-0.0722)},\qquad c_r=\frac{R'-y'}{2(1-0.2126)}`;
    await editor.fill([
      "黑位为 $L_B$。", `$$ ${fraction} $$`, `$$\n${matrix}\n$$`, `$$ ${coefficients} $$`,
      "源码 `$x$`，价格 \\$5。", "```text\n$$ original $$\n```", String.raw`$\frac{1}{$`, "后续段落。",
    ].join("\n\n"));
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await preview.locator("math msub").first().waitFor({ state: "attached" });
    const displayMath = preview.locator(".katex-display");
    assert.equal(await displayMath.count(), 3);
    assert.equal(await displayMath.first().locator("math mfrac").count(), 1);
    assert.equal(await preview.locator(".katex-display math mtable").count(), 1);
    assert.ok(await displayMath.last().evaluate(element => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft > 0;
    }), "a wide equation can scroll inside the mobile preview");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await preview.locator("p code").textContent(), "$x$");
    assert.equal(await preview.locator("pre code").textContent(), "$$ original $$\n");
    assert.ok(await preview.getByText("源码 $x$，价格 $5。").isVisible());
    assert.equal(await preview.locator(".katex-error").count(), 1);
    assert.ok(await preview.getByText("后续段落。").isVisible());
    report.checks.push({ name: "inline-and-display-math", status: "passed" });
    if (fixture) {
      await verifyFolderImport(page, fixture);
      report.checks.push({ name: "folder-import-recovery-preview-and-draft-save", status: "passed" });
    }
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

async function chooseImport(page, label, files) {
  await page.getByRole("button", { name: "导入文件", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入文件", exact: true });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: label, exact: true }).click(),
  ]);
  await chooser.setFiles(files);
  await dialog.waitFor({ state: "hidden" });
}

async function verifyWritingTools(page, editor, preview) {
  async function format(label, source, start, end) {
    await editor.fill(source);
    await editor.evaluate((element, range) => element.setSelectionRange(...range), [start, end]);
    await page.getByRole("button", { name: label, exact: true }).click();
  }

  for (const [label, source, end, markdown, selector, rendered] of [
    ["三级标题", "", 0, "### 标题", "h3", "标题"],
    ["删除线", "删除此字", 2, "~~删除~~此字", "del", "删除"],
    ["任务列表", "剪辑", 2, "- [ ] 剪辑", "li input[type=checkbox]", ""],
    ["代码块", "```\n示例\n```", 10, "````\n```\n示例\n```\n````", "pre > code", "```\n示例\n```"],
  ]) {
    await format(label, source, 0, end);
    await preview.locator(selector).waitFor();
    assert.equal(await editor.inputValue(), markdown);
    assert.equal((await preview.locator(selector).textContent()).trim(), rendered);
    if (label === "三级标题") {
      await page.keyboard.insertText("剪辑笔记");
      await preview.getByRole("heading", { name: "剪辑笔记", level: 3 }).waitFor();
    }
  }

  const selectedLines = "拍摄\n \t\n剪辑\n";
  for (const [label, markdown, list] of [
    ["有序列表", "1. 拍摄\n \t\n2. 剪辑", "ol"],
    ["任务列表", "- [ ] 拍摄\n \t\n- [ ] 剪辑", "ul"],
    ["无序列表", "- 拍摄\n \t\n- 剪辑", "ul"],
  ]) {
    await format(label, selectedLines + "结束", 0, selectedLines.length);
    assert.equal(await editor.inputValue(), markdown + "\n\n结束");
    await preview.locator(`article > ${list} + p`).filter({ hasText: /^结束$/ }).waitFor();
    assert.deepEqual((await preview.locator(`${list} > li`).allTextContents()).map(text => text.trim()), ["拍摄", "剪辑"]);
  }

  await format("三级标题", "拍摄\n\n剪辑", 0, 6);
  assert.equal(await editor.inputValue(), "### 拍摄\n\n### 剪辑");
  await preview.getByRole("heading", { name: "剪辑", level: 3 }).waitFor();

  await format("有序列表", "拍摄\n\n结束", 0, 2);
  assert.equal(await editor.inputValue(), "1. 拍摄\n\n结束");
  await format("有序列表", "拍摄\n2. 剪辑", 0, 2);
  assert.equal(await editor.inputValue(), "1. 拍摄\n2. 剪辑");

  await format("删除线", "keep old text next", 4, 14);
  assert.equal(await editor.inputValue(), "keep ~~old text~~ next");
  await preview.locator("del").filter({ hasText: /^old text$/ }).waitFor();
  assert.equal(await editor.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), "old text");
  await format("删除线", "keep  next", 4, 6);
  assert.equal(await editor.inputValue(), "keep  next");
}

async function verifyFolderImport(page, fixture) {
  const sharp = require("sharp");
  const root = path.join(fixture.temp, "图文稿");
  for (const dir of ["notes", "sdr", "hdr"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [dir, width, background] of [["sdr", 180, "#5b8c9e"], ["hdr", 240, "#be7e50"]]) {
    await sharp({ create: { width, height: 80, channels: 3, background } }).png().toFile(path.join(root, dir, "图 1.png"));
  }
  await fs.copyFile(path.join(root, "sdr", "图 1.png"), path.join(root, "unused.png"));
  const doc = path.join(root, "notes", "色彩笔记.md");
  const original = [
    "# 色彩笔记", '![日光](<../sdr/图 1.png> "原图")', "![暮色][hdr]", "![对照](../sdr/图%201.png)",
    '[hdr]: <../hdr/图 1.png>', "`![示例](example.png)`",
  ].join("\n\n");
  await fs.writeFile(doc, original);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "分栏", exact: true }).click();
  const editor = page.locator("#article-content");
  await editor.fill("保留到确认替换");
  async function chooseFolder(button) {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button.click()]);
    await chooser.setFiles(root);
  }
  await chooseImport(page, "选择文件夹", root);
  const confirm = page.getByRole("dialog", { name: "替换当前正文？" });
  await confirm.getByRole("button", { name: "取消" }).click();
  assert.equal(await editor.inputValue(), "保留到确认替换");
  assert.equal(await page.getByText("正文已引用", { exact: true }).count(), 0);
  await chooseImport(page, "选择 Markdown 文件", doc);
  const missing = page.getByRole("dialog", { name: "未找到引用的本地图片" });
  await missing.getByText("../hdr/图 1.png", { exact: true }).waitFor();
  await chooseFolder(missing.getByRole("button", { name: "选择文章和图片所在文件夹" }));
  await confirm.getByRole("button", { name: "替换正文" }).click();
  const preview = page.getByRole("region", { name: "文章预览", exact: true });
  const images = preview.getByRole("img");
  await images.nth(2).waitFor();
  assert.deepEqual(await images.evaluateAll(async imgs => Promise.all(imgs.map(async img => {
    await img.decode();
    return [img.alt, img.naturalWidth, img.src.startsWith("blob:")];
  }))), [["日光", 180, true], ["暮色", 240, true], ["对照", 180, true]]);
  assert.equal(await page.getByText("正文已引用", { exact: true }).count(), 2);
  assert.equal(await images.first().getAttribute("title"), "原图");
  assert.equal(fixture.collections.files.length, 0);
  await page.getByRole("region", { name: "Markdown 正文", exact: true }).screenshot({ path: path.join(output, "local-image-preview.png") });

  await page.locator("#article-slug").fill("folder-photo-test");
  await page.locator("#article-token").fill(fixture.token);
  const [response] = await Promise.all([
    page.waitForResponse(res => res.url().endsWith("/api/articles") && res.request().method() === "POST"),
    page.getByRole("button", { name: /^保存草稿/ }).click(),
  ]);
  assert.ok(response.ok(), `Save returned ${response.status()}: ${await response.text()}`);
  const post = fixture.collections.posts.find(row => row.slug === "folder-photo-test");
  assert.equal(post.published, false);
  assert.equal(fixture.collections.files.length, 2);
  const persisted = Array.from(post.content.matchAll(/\/api\/assets\/([\w-]+)/g), match => match[1]);
  assert.equal(persisted.length, 3);
  assert.equal(persisted[0], persisted[2]);
  assert.notEqual(persisted[0], persisted[1]);
  assert.ok(post.content.includes("原图") && post.content.includes("`![示例](example.png)`"));
  await page.getByText("内容已保存", { exact: true }).waitFor();
  // Multipart text fields travel with CRLF; textarea.value exposes LF.
  assert.equal(await editor.inputValue(), post.content.replace(/\r\n/g, "\n"));
  await page.waitForFunction(() => {
    const imgs = document.querySelectorAll('[aria-label="文章预览"] img');
    return imgs.length === 3 && [...imgs].every(img => img.complete && img.naturalWidth > 0);
  });
}

async function assertScrollFollows(source, target) {
  const progress = await source.evaluate(element => element.scrollTop / (element.scrollHeight - element.clientHeight));
  const error = await target.evaluate((element, progress) =>
    Math.abs(element.scrollTop - progress * (element.scrollHeight - element.clientHeight)), progress);
  assert.ok(error <= 1, `Split panes follow each other within one pixel (difference ${error})`);
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

async function run() {
  if (!process.argv.includes("--fixture")) return main();
  const { startFixture } = require("./helpers/create-menu-fixture.cjs");
  const fixture = await startFixture({ name: "article-local-images", cmsPort: 18355, apiPort: 18360, webPort: 13366, production: true });
  try { await main(fixture); } finally { await fixture.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
