const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const sharp = require("sharp");
const { webkit } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { startFixture } = require("./helpers/create-menu-fixture.cjs");

async function main() {
  process.env.SITE_HOME_PROFILE_BIO = "第一行说明\\n第二行说明";
  const fixture = await startFixture({ name: "home", cmsPort: 18101, apiPort: 18106, webPort: 13021 });
  const pass = name => console.log(`PASS ${name}`);
  const exhibit = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>exhibit</title><body style='background:#123'>exhibit</body>");
  });
  let browser;
  const errors = [];
  try {
    await new Promise((resolve, reject) => { exhibit.once("error", reject); exhibit.listen(18128, "127.0.0.1", resolve); });
    fixture.collections.albums[0].created_at = "2026-02-01T00:00:00Z";
    Object.assign(fixture.collections.posts[0], { title: "最新的文章", created_at: "2026-03-15T00:00:00Z" });
    fixture.collections.video_projects.push({ id: 1, title: "最早的视频", slug: "first-video", published: true, created_at: "2026-01-01T00:00:00Z", masters: [] });
    fixture.collections.external_projects.push({ id: 1, title: "最新的网站", url: "http://127.0.0.1:18078/site", open_mode: "external",
      preview_enabled: false, cover_image: null, published: true, sort_order: 1, created_at: "2026-03-01T00:00:00Z" });
    fixture.collections.external_projects.push({ id: 2, title: "草稿网站", url: "http://127.0.0.1:18078/draft", open_mode: "iframe",
      preview_enabled: false, cover_image: null, published: false, sort_order: 2, created_at: "2026-04-01T00:00:00Z" });
    browser = await webkit.launch({ headless: true, executablePath: process.env.WEBKIT_EXECUTABLE || undefined });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${fixture.url}/`, { waitUntil: "networkidle" });

    const summary = page.locator(".profile-hub .summary");
    assert.equal(await summary.innerText(), "第一行说明\n第二行说明");
    pass("a literal \\n in the profile bio breaks the line");

    const frames = page.locator(".contact-frame");
    assert.deepEqual(await frames.evaluateAll(links => links.map(link => link.querySelector(".contact-frame-label").textContent)),
      ["01-01最早的视频", "02-01验收相簿", "03-01最新的网站", "03-15最新的文章"]);
    assert.equal(await frames.nth(3).locator(".contact-frame-label time").getAttribute("datetime"), "03-15");
    assert.equal(await frames.nth(0).getAttribute("href"), "/videos/first-video");
    assert.equal(await frames.nth(1).getAttribute("href"), "/albums/fixture-album");
    assert.equal(await frames.nth(2).getAttribute("target"), "_blank");
    assert.equal(await frames.nth(3).getAttribute("href"), "/posts/fixture-post");
    assert.equal(await frames.nth(3).locator(".contact-frame-title").innerText(), "最新的文章");
    const strip = await page.locator(".contact-strip-track").boundingBox();
    assert.ok(strip.height <= 96, `The strip should stay low, got ${strip.height}px.`);
    assert.ok(strip.y + strip.height <= 900, "The strip sits on the first screen.");
    assert.match(await page.locator(".contact-strip").evaluate(element => {
      const style = getComputedStyle(element);
      return style.maskImage || style.webkitMaskImage;
    }), /linear-gradient\(.*30%.*70%/, "The film fades toward both edges.");
    const pageCentre = async () => {
      const box = await frames.nth(3).boundingBox();
      return Math.abs(box.x + box.width / 2 - await page.evaluate(() => {
        const strip = document.querySelector(".contact-strip").getBoundingClientRect();
        return strip.left + strip.width / 2;
      }));
    };
    assert.ok(await pageCentre() < 1, "The newest frame holds the centre of the page.");
    const label = frames.nth(3).locator(".contact-frame-label");
    assert.equal(await label.evaluate(element => getComputedStyle(element).opacity), "0");
    await frames.nth(3).hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelectorAll(".contact-frame-label")[3]).opacity === "1");
    const labelBox = await label.boundingBox();
    const frameBox = await frames.nth(3).boundingBox();
    assert.ok(Math.abs(labelBox.x + labelBox.width / 2 - (frameBox.x + frameBox.width / 2)) < 1, "The label is centred under its frame.");
    const visibleEdge = await page.locator(".contact-strip").evaluate(element => element.getBoundingClientRect().bottom);
    assert.ok(labelBox.y + labelBox.height <= visibleEdge, "The second line is not clipped.");
    assert.ok(await page.locator(".contact-strip").evaluate(element => element.scrollHeight <= element.clientHeight), "No vertical scroll appears in the strip.");
    pass("the low contact strip runs every published collection left to right, oldest first, without drafts");

    const film = page.locator(".contact-strip-track");
    const lamp = () => film.evaluate(track => {
      const style = getComputedStyle(track);
      return { lit: track.dataset.lamp, x: parseFloat(style.getPropertyValue("--lamp-x")), glow: Number(style.getPropertyValue("--lamp-glow")) };
    });
    const frameCentre = nth => frames.nth(nth).evaluate(link => link.parentElement.offsetLeft + link.parentElement.offsetWidth / 2);
    await page.waitForTimeout(350);
    const lifted = await frames.nth(3).locator(".contact-frame-picture").boundingBox();
    assert.ok(Math.abs(lifted.height - 62 * 1.14) < 1, `The hovered frame rises, got ${lifted.height}px.`);
    assert.ok(Math.abs(lifted.y + lifted.height - (frameBox.y + 62)) < 1, "It rises from its lower edge, clear of the label.");
    assert.ok(lifted.y >= strip.y, "The risen frame stays on the film.");
    assert.deepEqual(await lamp(), { lit: "on", x: await frameCentre(3), glow: 1 });
    await frames.nth(0).hover();
    await page.waitForTimeout(70);
    const gliding = await lamp();
    assert.ok(gliding.x < await frameCentre(3) && gliding.x > await frameCentre(0), `The lamp glides between frames, got ${gliding.x}.`);
    await page.mouse.move(10, 10);
    await page.waitForTimeout(350);
    assert.deepEqual(await lamp().then(({ lit, glow }) => ({ lit, glow })), { lit: undefined, glow: 0 });
    await frames.nth(3).hover();
    await page.waitForTimeout(60);
    assert.equal((await lamp()).x, await frameCentre(3), "An unlit lamp comes on under its frame instead of gliding to it.");
    await page.mouse.move(10, 10);
    await page.keyboard.press("Shift");
    await frames.nth(1).focus();
    await page.waitForTimeout(350);
    assert.deepEqual(await lamp(), { lit: "on", x: await frameCentre(1), glow: 1 });
    assert.ok((await frames.nth(1).locator(".contact-frame-picture").boundingBox()).height > 70, "Keyboard focus lifts the frame too.");
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(350);
    assert.equal((await lamp()).lit, undefined);
    pass("hovering or focusing a frame lifts it over a lamp that follows along the film");

    const cover = new FormData();
    cover.append("title", "cover");
    cover.append("file", new Blob([await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#c0392b" } }).png().toBuffer()], { type: "image/png" }), "cover.png");
    fixture.collections.posts[0].cover_image = (await (await fetch(`${fixture.cmsUrl}/files`, { method: "POST", body: cover })).json()).data.id;
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await frames.nth(3).hover();
    await page.waitForTimeout(250);
    const opening = await frames.nth(3).locator(".contact-frame-picture").boundingBox();
    await frames.nth(3).click();
    await page.waitForFunction(() => document.getAnimations().some(animation => animation.animationName === "vt-wipe-reveal-frame"));
    const origin = await page.evaluate(() => {
      const root = document.documentElement;
      const value = name => parseFloat(root.style.getPropertyValue(name));
      const animations = document.getAnimations().filter(animation => animation.effect?.pseudoElement?.startsWith("::view-transition"));
      animations.forEach(animation => { animation.pause(); animation.currentTime = 600; });
      return { origin: root.dataset.vtOrigin, cover: root.dataset.vtCover, x: value("--frame-left"), y: value("--frame-top"), width: value("--frame-width"), height: value("--frame-height"),
        clocks: animations.filter(animation => /^vt-wipe/.test(animation.animationName || "")).length, landing: animations.some(animation => animation.animationName === "vt-cover-land") };
    });
    assert.deepEqual({ ...origin, x: Math.round(origin.x), y: Math.round(origin.y), width: Math.round(origin.width), height: Math.round(origin.height) },
      { origin: "frame", cover: "landed", clocks: 2, landing: true, x: Math.round(opening.x), y: Math.round(opening.y), width: Math.round(opening.width), height: Math.round(opening.height) });
    await page.waitForTimeout(60);
    const arriving = await page.locator('[data-vt="cover"]').boundingBox();
    const [red, , blue] = await sharp(await page.screenshot()).extract({ left: Math.round(arriving.x + arriving.width / 2), top: Math.round(arriving.y + arriving.height / 2), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.ok(red > 150 && blue < 90, `The cover is still solid as it lands, got ${red}/${blue}.`);
    await page.evaluate(() => document.getAnimations()
      .filter(animation => animation.effect?.pseudoElement?.startsWith("::view-transition")).forEach(animation => animation.finish()));
    await page.waitForURL("**/posts/fixture-post");
    await page.waitForFunction(() => !document.documentElement.dataset.vtOrigin && !document.querySelector(".route-wipe-line"));
    assert.equal(await page.evaluate(() => ["--frame-left", "--wipe-top"].some(name => document.documentElement.style.getPropertyValue(name)) || "vtCover" in document.documentElement.dataset), false);
    pass("a strip frame opens into its page from its own rectangle, carrying its cover and leaving nothing behind");

    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = callback => { window.__transitioned = true; return start(callback); };
    });
    await frames.nth(3).click();
    await page.waitForURL("**/posts/fixture-post");
    assert.equal(await page.evaluate(() => window.__transitioned), undefined);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    pass("under reduced motion a frame goes straight to its page");

    const painted = () => page.locator(".home-diagram canvas").evaluate(canvas => canvas.getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height).data.some(value => value !== 0));
    assert.equal(await painted(), true);
    const drawn = new Set();
    const kindOf = caption => /^波形/.test(caption) ? "waveform" : /^矢量图/.test(caption) ? "vectorscope" : "volume";
    for (let visit = 0; visit < 60 && drawn.size < 3; visit++) {
      drawn.add(kindOf(await page.locator(".home-diagram figcaption").innerText()));
      await page.reload({ waitUntil: "networkidle" });
    }
    assert.equal(drawn.size, 3, "Refreshing reaches every diagram.");
    pass("by default a refresh can land on any diagram");

    await page.evaluate(() => localStorage.setItem("mm-home-diagram-v2", JSON.stringify({ version: 2, diagram: "volume", gamut: "random", model: "xyz" })));
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await painted(), true);
    assert.equal(await page.locator(".liquid-bg").count(), 1);
    assert.equal(await page.evaluate(() => document.querySelector(".liquid-bg").getBoundingClientRect().width > 0), true);
    assert.match(await page.locator(".home-diagram figcaption").innerText(), /^(Rec\.709|P3-D65|Rec\.2020|ACES AP0) · CIE XYZ$/);
    pass("the diagram paints a random gamut in XYZ over the retained liquid background");

    await page.emulateMedia({ reducedMotion: "reduce" });
    const pixels = () => page.locator(".home-diagram canvas").evaluate(canvas => canvas.toDataURL());
    const solid = page.locator(".home-diagram canvas");
    const box = await solid.boundingBox();
    await page.waitForTimeout(100);
    const before = await pixels();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await solid.evaluate(canvas => getComputedStyle(canvas).cursor), "grab");
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    assert.notEqual(await pixels(), before, "Dragging turns the solid even with reduced motion.");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    pass("the colour volume turns under a mouse drag");

    await page.evaluate(() => {
      const prototype = CanvasRenderingContext2D.prototype;
      const fillText = prototype.fillText;
      window.__labelPath = [];
      prototype.fillText = function (text, x, ...rest) {
        if (text === "X") window.__labelPath.push(x);
        return fillText.call(this, text, x, ...rest);
      };
    });
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) await page.mouse.move(box.x + 60 + step * 42, box.y + box.height / 2);
    await page.mouse.up();
    // Only the coast counts: under the hand the solid follows the pointer exactly.
    await page.evaluate(() => { window.__labelPath = []; });
    await page.waitForTimeout(900);
    const labelPath = await page.evaluate(() => window.__labelPath);
    const fastest = Math.max(...labelPath.slice(1).map((x, index) => Math.abs(x - labelPath[index])));
    assert.ok(fastest < box.width * 0.25, `A flick stays readable, moved ${fastest}px in one frame.`);
    pass("a hard flick cannot spin the colour volume into a strobe");

    const longStrip = page.locator(".contact-strip");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const element = document.querySelector(".contact-strip");
      return element.scrollWidth > element.clientWidth;
    });
    assert.equal(await longStrip.evaluate(element => Math.abs(element.scrollLeft)), 0, "A long strip opens on its newest frame.");
    assert.ok(await pageCentre() < 1, "The newest frame stays centred on a long strip.");
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No horizontal page scroll on a phone.");
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.getByRole("button", { name: "外观设置", exact: true }).click();
    const options = page.getByRole("group", { name: "首页图示", exact: true });
    const rowHeights = await page.evaluate(async () => {
      const rows = document.querySelector(".home-diagram-rows");
      const before = rows.getBoundingClientRect().height;
      [...document.querySelectorAll('[aria-label="首页图示"] button')].find(button => button.textContent === "矢量图").click();
      const heights = [];
      for (let frame = 0; frame < 5; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        heights.push(rows.getBoundingClientRect().height);
      }
      return { before, heights, animating: rows.dataset.panelAnimating };
    });
    assert.ok(new Set(rowHeights.heights).size > 1 && rowHeights.heights[0] < rowHeights.heights.at(-1), `Rows ease open, got ${JSON.stringify(rowHeights)}.`);
    const signals = page.getByRole("group", { name: "信号", exact: true });
    const looks = page.getByRole("group", { name: "样式", exact: true });
    const phosphors = page.getByRole("group", { name: "荧光色", exact: true });
    const drawingCaption = () => page.locator(".home-diagram figcaption").innerText();
    const drawingPixels = () => page.locator(".home-diagram canvas").evaluate(canvas => canvas.toDataURL());
    await signals.getByRole("button", { name: "75%", exact: true }).click();
    await looks.getByRole("button", { name: "标准", exact: true }).click();
    await phosphors.getByRole("button", { name: "白", exact: true }).click();
    assert.equal(await drawingCaption(), "矢量图 · 标准 · 75% 彩条 · Rec.709");
    const seenLooks = new Set([await drawingPixels()]);
    for (const [group, name] of [[looks, "点阵"], [looks, "×2"], [signals, "色相环"], [signals, "色卡"], [phosphors, "信号色"]]) {
      const previous = await drawingPixels();
      await group.getByRole("button", { name, exact: true }).click();
      await page.waitForFunction(last => document.querySelector(".home-diagram canvas").toDataURL() !== last, previous);
      seenLooks.add(await drawingPixels());
    }
    assert.equal(seenLooks.size, 6, "Each vectorscope option changes the drawing.");
    await options.getByRole("button", { name: "波形", exact: true }).click();
    for (const [name, label] of [["亮度", "亮度"], ["RGB", "RGB 分量"], ["YCbCr", "YCbCr 分量"], ["叠加", "RGB 叠加"]]) {
      await looks.getByRole("button", { name, exact: true }).click();
      assert.match(await drawingCaption(), new RegExp(`^波形 · ${label} · `));
    }
    await options.getByRole("button", { name: "矢量图", exact: true }).click();
    assert.equal(await page.locator(".home-diagram[data-draggable]").count(), 0, "Only the solid can be turned.");
    assert.equal(await page.getByRole("group", { name: "色彩空间", exact: true }).count(), 0);
    await options.getByRole("button", { name: "色彩体积", exact: true }).click();
    await page.getByRole("group", { name: "色彩空间", exact: true }).getByRole("button", { name: "2020", exact: true }).click();
    const xyY = page.getByRole("group", { name: "坐标", exact: true }).getByRole("button", { name: "xyY", exact: true });
    await xyY.focus();
    await page.keyboard.press("Enter");
    assert.equal(await xyY.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".home-diagram figcaption").innerText(), "Rec.2020 · CIE xyY · 白色 Y=1");
    await page.reload({ waitUntil: "networkidle" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".home-diagram figcaption").innerText(), "Rec.2020 · CIE xyY · 白色 Y=1");
    assert.equal(await painted(), true);
    await page.screenshot({ path: path.join(fixture.output, "home-xyy.png"), fullPage: true });
    await page.locator(".home-diagram").screenshot({ path: path.join(fixture.output, "xyy-volume.png") });
    const still = await pixels();
    await page.waitForTimeout(150);
    assert.equal(await pixels(), still, "xyY remains still under reduced motion.");
    const xyYBox = await solid.boundingBox();
    await page.mouse.move(xyYBox.x + xyYBox.width / 2, xyYBox.y + xyYBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(xyYBox.x + xyYBox.width / 2 + 60, xyYBox.y + xyYBox.height / 2 + 20, { steps: 4 });
    await page.mouse.up();
    assert.notEqual(await pixels(), still, "xyY still supports explicit rotation.");
    await page.setViewportSize({ width: 320, height: 844 });
    await page.getByRole("button", { name: "外观设置", exact: true }).click();
    assert.equal(await xyY.getAttribute("aria-pressed"), "true");
    const coordinates = page.getByRole("group", { name: "坐标", exact: true });
    const coordinateButtons = await coordinates.getByRole("button").evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect();
      return { top: box.top, left: box.left, right: box.right, fits: button.scrollWidth <= button.clientWidth };
    }));
    assert.equal(coordinateButtons.length, 6);
    assert.equal(new Set(coordinateButtons.map(button => button.top)).size, 2, "The six models use two rows.");
    assert.ok(coordinateButtons.every(button => button.fits && button.left >= 0 && button.right <= 320));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await xyY.click(); // Scroll the coordinate controls into the panel's visible area.
    await page.screenshot({ path: path.join(fixture.output, "home-xyy-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    pass("xyY supports keyboard selection, persistence, reduced motion, dragging and narrow-screen settings");
    await page.getByRole("group", { name: "坐标", exact: true }).getByRole("button", { name: "CAM16", exact: true }).click();
    await page.getByRole("group", { name: "色彩空间", exact: true }).getByRole("button", { name: "AP0", exact: true }).click();
    assert.equal(await page.locator(".home-diagram figcaption").innerText(), "ACES AP0 · CAM16-UCS");
    await page.waitForFunction(() => document.querySelector(".home-diagram canvas").getContext("2d")
      .getImageData(0, 0, 400, 400).data.some(value => value !== 0));
    await options.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator(".home-diagram").waitFor({ state: "detached" });
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator(".home-diagram").count(), 0, "The choice survives a reload.");
    await page.getByRole("button", { name: "外观设置", exact: true }).click();
    await page.getByRole("button", { name: "恢复背景默认", exact: true }).click();
    await page.locator(".home-diagram").waitFor();
    pass("the appearance panel switches, configures, remembers and resets the diagram");
    await page.keyboard.press("Escape");

    await page.goto(`${fixture.url}/albums`, { waitUntil: "networkidle" });
    assert.equal(await page.locator(".home-diagram").count(), 0);
    await page.goBack({ waitUntil: "networkidle" });
    await page.evaluate(() => document.documentElement.classList.add("route-transition-pending"));
    await page.waitForFunction(() => getComputedStyle(document.body, "::after").opacity === "1");
    assert.match(await page.evaluate(() => getComputedStyle(document.body, "::after").backgroundImage), /rgb\(0, 0, 0\).*rgb\(255, 255, 255\)/);
    const lineExit = await page.evaluate(async () => {
      document.documentElement.classList.remove("route-transition-pending");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const style = getComputedStyle(document.body, "::after");
      return { opacity: Number(style.opacity), transform: style.transform };
    });
    assert.equal(lineExit.transform, "matrix(1, 0, 0, 1, 0, 0)", "The line reaches its white end as it finishes.");
    assert.ok(lineExit.opacity > 0.3, `The finished line stays visible while it fades, got ${lineExit.opacity}.`);
    await page.screenshot({ path: path.join(fixture.output, "home.png"), fullPage: true });
    pass("the loading line ramps from black to white and the diagram stays on the home page");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    fixture.collections.external_projects.push(...[3, 4, 5, 6].map(id => ({ id, title: `实时网站${id}`, url: `http://127.0.0.1:18128/site${id}`,
      open_mode: "iframe", preview_enabled: true, cover_image: null, published: true, sort_order: id, created_at: `2026-05-0${id}T00:00:00Z` })));
    await page.goto(`${fixture.url}/`, { waitUntil: "networkidle" });
    const live = page.locator(".contact-frame iframe");
    await live.nth(2).waitFor({ state: "attached" });
    assert.deepEqual(await live.evaluateAll(frames => frames.map(frame => new URL(frame.src).pathname)), ["/site4", "/site5", "/site6"]);
    assert.equal(await live.first().evaluate(frame => Boolean(frame.closest("[inert]"))), true);
    assert.equal(await page.locator(".contact-frame", { hasText: "最新的网站" }).locator("iframe").count(), 0, "A site with previews off stays a title.");
    const frameWidth = await live.first().evaluate(frame => frame.getBoundingClientRect().width);
    assert.ok(frameWidth < 93, `The page fits inside its frame, got ${frameWidth}px.`);
    await page.locator(".contact-frame", { hasText: "实时网站6" }).click();
    await page.waitForURL(`${fixture.url}/project?project=6`);
    await page.goto(`${fixture.url}/`, { waitUntil: "networkidle" });
    await live.first().waitFor({ state: "attached" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => !document.querySelector(".contact-frame iframe"));
    assert.equal(await page.locator(".contact-frame", { hasText: "实时网站6" }).locator(".contact-frame-title").count(), 1);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.screenshot({ path: path.join(fixture.output, "home-live.png"), fullPage: true });
    pass("coverless laboratory sites preview live in the strip: newest three, inert, still links, off under reduced motion");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "外观设置", exact: true }).click();
    await options.getByRole("button", { name: "色彩体积", exact: true }).click();
    await xyY.click();
    const other = await context.newPage();
    await other.goto(fixture.url, { waitUntil: "networkidle" });
    assert.match(await other.locator(".home-diagram figcaption").innerText(), /xyY/);
    await other.getByRole("button", { name: "外观设置", exact: true }).click();
    await other.getByRole("button", { name: "恢复背景默认", exact: true }).click();
    await page.bringToFront();
    await page.waitForFunction(() => document.querySelector('[aria-label="首页图示"] [aria-pressed="true"]')?.textContent === "随机");
    assert.equal(await page.evaluate(() => localStorage.getItem("mm-home-diagram-v2")), null);
    await page.screenshot({ path: path.join(fixture.output, "home-cross-tab-reset.png"), fullPage: true, animations: "disabled" });
    await other.close();
    await page.keyboard.press("Escape");
    pass("resetting defaults in another tab clears a previously saved local selection");

    // A scoped storage failure isolates the case where reads still return the old
    // persisted choice. Closing this context restores the native storage methods.
    const blocked = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce",
      storageState: { cookies: [], origins: [{ origin: fixture.url, localStorage: [{ name: "mm-home-diagram-v2",
        value: JSON.stringify({ version: 2, diagram: "volume", gamut: "rec2020", model: "xyz" }) }] }] } });
    try {
      await blocked.addInitScript(() => {
        for (const method of ["setItem", "removeItem"]) {
          const original = Storage.prototype[method];
          Storage.prototype[method] = function (key, ...args) {
            if (key === "mm-home-diagram-v2") throw new DOMException("Fixture storage unavailable", "QuotaExceededError");
            return original.call(this, key, ...args);
          };
        }
      });
      const fallback = await blocked.newPage();
      await fallback.goto(fixture.url, { waitUntil: "networkidle" });
      await fallback.getByRole("button", { name: "外观设置", exact: true }).click();
      await fallback.getByRole("group", { name: "首页图示", exact: true }).getByRole("button", { name: "色彩体积", exact: true }).click();
      await fallback.getByRole("group", { name: "坐标", exact: true }).getByRole("button", { name: "xyY", exact: true }).click();
      assert.match(await fallback.locator(".home-diagram figcaption").innerText(), /xyY/);
      await fallback.getByRole("group", { name: "首页图示", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
      await fallback.locator(".home-diagram").waitFor({ state: "detached" });
      await fallback.getByRole("button", { name: "恢复背景默认", exact: true }).click();
      await fallback.locator(".home-diagram").waitFor();
      assert.equal(await fallback.getByRole("group", { name: "首页图示", exact: true }).getByRole("button", { name: "随机", exact: true }).getAttribute("aria-pressed"), "true");
    } finally { await blocked.close(); }
    pass("failed storage writes and removals retain working local choices and resets");

    const project = id => ({ id, title: `回归网站${id}`, url: `http://127.0.0.1:18128/project/${id}`,
      open_mode: "iframe", preview_enabled: false, cover_image: null, published: true, sort_order: 0,
      created_at: new Date(Date.UTC(2027, 0, id)).toISOString() });
    fixture.collections.external_projects.splice(0, fixture.collections.external_projects.length,
      ...Array.from({ length: 30 }, (_, index) => project(index + 1)), { ...project(31), title: "回归草稿", published: false });
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator('.contact-frame[href="/project?project=1"]').click();
    await page.waitForFunction(() => document.getAnimations().some(animation => animation.animationName === "vt-wipe-reveal-frame"));
    assert.equal(await page.evaluate(() => document.querySelector("dialog.project-viewer")?.open), true, "The frame opens into the site, not onto the list.");
    await page.waitForURL(`${fixture.url}/project?project=1`);
    const linkedViewer = page.getByRole("dialog", { name: "回归网站1", exact: true });
    await linkedViewer.waitFor();
    assert.equal(await linkedViewer.locator("iframe").getAttribute("src"), "http://127.0.0.1:18128/project/1", "A strip link opens the site itself.");
    assert.equal(await page.locator('ol[aria-label="网站作品"] > li').count(), 25, "Only the requested row is added to the first page.");
    await linkedViewer.getByRole("button", { name: "← 返回实验室", exact: true }).click();
    await linkedViewer.waitFor({ state: "hidden" });
    assert.equal(page.url(), `${fixture.url}/project`, "Closing drops the query.");
    assert.equal(await page.locator("#project-1").count(), 1, "Closing keeps a row from beyond the first page.");
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "查看回归网站1", "Focus returns to the card.");
    await page.getByRole("button", { name: "查看回归网站1", exact: true }).click();
    await linkedViewer.waitFor();
    assert.equal(await linkedViewer.locator("iframe").count(), 1, "The card still opens its viewer.");
    await page.keyboard.press("Escape");
    await linkedViewer.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('ol[aria-label="网站作品"] > li').length === 30);
    assert.equal(await page.locator("#project-1").count(), 1, "Ordinary pagination does not duplicate the requested row.");
    await page.screenshot({ path: path.join(fixture.output, "home-project-target.png"), fullPage: true });
    await page.goto(`${fixture.url}/project?project=7`, { waitUntil: "networkidle" });
    await page.getByRole("dialog", { name: "回归网站7", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => scrollY), 0, "The list does not move under the viewer.");
    await page.keyboard.press("Escape");
    await page.waitForURL(`${fixture.url}/project`);
    await page.waitForFunction(() => scrollY > 0);
    const landing = await page.evaluate(() => ({
      card: document.querySelector("#project-7").getBoundingClientRect().top,
      header: document.querySelector(".site-header").getBoundingClientRect().bottom,
    }));
    assert.ok(landing.card >= landing.header, `A linked card lands below the header, got ${JSON.stringify(landing)}.`);
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.getByRole("dialog").count(), 0, "A reload after closing shows the laboratory.");
    fixture.collections.external_projects[9].open_mode = "external";
    await page.goto(`${fixture.url}/project?project=10`, { waitUntil: "networkidle" });
    await page.locator("#project-10").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "An independently opened site stays a card.");
    for (const id of [31, 999]) {
      await page.goto(`${fixture.url}/project?project=${id}`, { waitUntil: "networkidle" });
      await page.getByText("此网站已下架或不存在，以下为其他已发布作品。", { exact: true }).waitFor();
      assert.equal(await page.locator(`#project-${id}`).count(), 0);
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert.equal(await page.locator('ol[aria-label="网站作品"] > li').count(), 24);
    }
    pass("contact links resolve later-page projects without exposing drafts or breaking pagination");

    fixture.collections.external_projects.splice(0, fixture.collections.external_projects.length,
      ...Array.from({ length: 200 }, (_, index) => project(index + 1)));
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    assert.equal(await page.locator('.contact-frame[href="/project?project=1"]').count(), 1);
    fixture.collections.external_projects.push(project(201));
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator('.contact-frame[href="/project?project=201"]').count(), 1);
    assert.equal(await page.locator('.contact-frame[href="/project?project=1"]').count(), 0);
    assert.equal(await page.locator(".contact-frame").count(), 203, "Display payloads retain their per-collection limit.");
    pass("the strip keeps the newest 200 projects at its per-collection limit");

    const video = id => ({ id, title: `时间线视频${id}`, slug: `timeline-${id}`, published: true, sort_order: id === 201 ? 1 : 0, masters: [],
      created_at: new Date(Date.UTC(2028, 0, id)).toISOString() });
    fixture.collections.video_projects.splice(0, fixture.collections.video_projects.length, ...Array.from({ length: 201 }, (_, index) => video(index + 1)));
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    assert.equal(await page.locator('.contact-frame[href="/videos/timeline-201"]').count(), 1, "A low display priority cannot hide the newest video.");
    assert.equal(await page.locator('.contact-frame[href="/videos/timeline-1"]').count(), 0, "The oldest video makes room.");
    pass("the strip chooses recent videos by date, whatever their display order");

    const focusFrame = async nth => {
      const frame = page.locator(".contact-frame").nth(nth);
      await frame.focus();
      await page.waitForTimeout(100);
      const box = await frame.boundingBox();
      const width = await page.locator(".contact-strip").evaluate(element => element.clientWidth);
      return { left: box.x / width, right: (box.x + box.width) / width };
    };
    for (const nth of [0, 1, 40, 120]) {
      const { left, right } = await focusFrame(nth);
      assert.ok(left >= 0.295 && right <= 0.705, `Focused frame ${nth} stays clear of the fades, got ${left.toFixed(3)}–${right.toFixed(3)}.`);
    }
    await page.locator(".contact-strip").evaluate(element => { element.scrollLeft = -element.scrollWidth; });
    const earliest = await page.locator(".contact-frame").first().boundingBox();
    assert.ok(earliest.x >= 1280 * 0.295, `The oldest frame scrolls clear of the left fade, got ${earliest.x}.`);
    pass("the oldest frame and keyboard focus reach the opaque part of the strip");

    fixture.collections.external_projects.splice(0, fixture.collections.external_projects.length);
    fixture.collections.video_projects.splice(0, fixture.collections.video_projects.length, video(1));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture.url, { waitUntil: "networkidle" });
    const phoneFilm = await page.locator(".contact-strip-track").boundingBox();
    assert.ok(phoneFilm.y < 844 - 60, `A phone shows the film on its first screen, got y=${phoneFilm.y}.`);
    await page.setViewportSize({ width: 390, height: 1200 });
    const tallFilm = await page.locator(".contact-strip").boundingBox();
    assert.ok(tallFilm.y + tallFilm.height >= 1190, `A short page keeps the strip at the bottom, ended at ${tallFilm.y + tallFilm.height}.`);
    await page.setViewportSize({ width: 390, height: 500 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), "Long content still scrolls.");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 1280, height: 900 });
    pass("a phone shows the strip on its first screen and keeps normal scrolling");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => exhibit.close(resolve));
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
