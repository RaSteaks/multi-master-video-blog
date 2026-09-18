/* Real WebGL regression check. Uses installed Edge; no browser dependency. */
const { createServer } = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync, mkdtempSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const ts = require("typescript");

const root = resolve(__dirname, "..");
const sourcePath = "apps/web/src/lib/liquid-fluid.ts";
const browser = process.env.FLUID_TEST_BROWSER ||
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
if (!existsSync(browser)) throw new Error("Set FLUID_TEST_BROWSER to a Chromium executable.");
const artifacts = mkdtempSync(join(tmpdir(), "liquid-webgl-"));
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 },
}).outputText;
const sources = {
  "/after.js": compile(readFileSync(join(root, sourcePath), "utf8")),
  "/before.js": compile(execFileSync("git", ["show", "HEAD:" + sourcePath], {
    cwd: root, encoding: "utf8",
  })),
};

async function exercise() {
  const results = [];
  const palette = [[130 / 255, 134 / 255, 138 / 255],
    [108 / 255, 112 / 255, 116 / 255], [118 / 255, 122 / 255, 126 / 255]];
  let callback = null;
  window.requestAnimationFrame = (cb) => { callback = cb; return 1; };
  window.cancelAnimationFrame = () => { callback = null; };
  window.ResizeObserver = undefined;
  window.IntersectionObserver = undefined;
  for (const [version, mobile, speed] of [
    ["before", false, 1], ["after", false, 1], ["after", true, 1], ["after", false, 3],
  ]) {
    window.matchMedia = () => ({ matches: mobile });
    const canvas = document.createElement("canvas");
    canvas.style.cssText = mobile
      ? "width:390px;height:844px;display:block"
      : "width:960px;height:640px;display:block";
    document.body.append(canvas);
    const { createLiquidFluidRenderer } = await import("/" + version + ".js");
    const controller = createLiquidFluidRenderer(canvas, { variant: "gray", speed, palette });
    if (!controller) throw new Error("WebGL initialization failed: " + version);
    const gl = canvas.getContext("webgl2");
    function pixels() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const data = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    }
    function velocity() {
      // TypeScript-private fields are inspected only in this test, not exposed in the app.
      const target = controller.velocityRead;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      const data = new Float32Array(target.width * target.height * 4);
      gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, data);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let max = 0, nonFinite = 0;
      for (let i = 0; i < data.length; i += 4) {
        for (const value of [data[i], data[i + 1]]) {
          if (!Number.isFinite(value)) nonFinite++;
          else max = Math.max(max, Math.abs(value));
        }
      }
      return { max, nonFinite };
    }
    function saveFrame() {
      const image = document.createElement("canvas");
      image.width = canvas.width; image.height = canvas.height;
      const ctx = image.getContext("2d");
      ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, image.width, image.height);
      ctx.filter = "blur(14px)";
      ctx.drawImage(canvas, -14, -14, image.width + 28, image.height + 28);
      return image.toDataURL("image/png").split(",")[1];
    }
    const initial = pixels();
    const initialPng = saveFrame();
    let previous = initial;
    let peakSpeed = 0, nonFinite = 0, visibleChange = 0, frameCount = 0;
    let midPng;
    // 30 seconds of 60 Hz callbacks, keeping the actual renderer's FPS limiter.
    const start = performance.now();
    for (let i = 1; i <= 1800; i++) {
      const cb = callback; callback = null;
      if (cb) cb(start + i * 1000 / 60);
      if (i % 60 === 0) {
        const field = velocity();
        peakSpeed = Math.max(peakSpeed, field.max);
        nonFinite += field.nonFinite;
        const current = pixels();
        let sum = 0;
        for (let j = 0; j < current.length; j += 4) {
          // Displayed red channel over the fixed black background.
          const displayed = (p) => p[j] * p[j + 3] / 255;
          sum += Math.abs(displayed(current) - displayed(previous));
        }
        visibleChange += sum / (current.length / 4);
        previous = current;
        frameCount++;
        if (i === 300) midPng = saveFrame();
      }
    }
    const final = pixels();
    let maxAlpha = 0;
    for (let i = 3; i < final.length; i += 4) maxAlpha = Math.max(maxAlpha, final[i]);
    const finalPng = saveFrame();
    const simTimeBeforeColorChange = controller.simTime;
    controller.update({ speed, palette: [[0, 0, 0], [0, 0, 0], [0, 0, 0]] });
    const black = pixels();
    const blackIsBlack = black.every((channel, i) => channel === (i % 4 === 3 ? 255 : 0));
    controller.update({ speed: 0, palette: [[1, 0, 0], [0.85, 0, 0], [0.92, 0, 0]] });
    const red = pixels();
    const redSelectable = red.some((channel, i) => i % 4 === 0 && channel > 20) &&
      red.every((channel, i) => (i % 4 === 1 || i % 4 === 2) ? channel === 0 : true);
    const recolorTimeUnchanged = controller.simTime === simTimeBeforeColorChange;
    const paused = callback === null;
    const errors = gl.getError();
    const result = {
      version, mobile, speed, grid: controller.simWidth, peakSpeed, nonFinite,
      meanPixelChangePerSecond: visibleChange / frameCount, maxAlpha, paused, errors,
      blackIsBlack, redSelectable, recolorTimeUnchanged,
      initialPng, midPng, finalPng,
    };
    results.push(result);
    controller.dispose();
    canvas.remove();
  }
  return results;
}

let child, timeout;
const server = createServer((req, res) => {
  if (req.url === "/result" && req.method === "POST") {
    let body = "";
    req.on("data", (data) => { body += data; });
    req.on("end", () => {
      try {
        const report = JSON.parse(body);
        if (report.error) throw new Error(report.error);
        for (const item of report) {
          const label = item.version + "-" + (item.mobile ? "mobile" : "desktop") + "-" + item.speed;
          for (const key of ["initialPng", "midPng", "finalPng"]) {
            writeFileSync(join(artifacts, label + "-" + key + ".png"), Buffer.from(item[key], "base64"));
            delete item[key];
          }
        }
        writeFileSync(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ artifacts, report }, null, 2));
        const passed = report.filter((r) => r.version === "after").every((r) =>
          r.nonFinite === 0 && r.peakSpeed < 1 && r.meanPixelChangePerSecond > 0.15 &&
          r.maxAlpha === 255 && r.paused && r.errors === 0 &&
          r.blackIsBlack && r.redSelectable && r.recolorTimeUnchanged &&
          r.grid === (r.mobile ? 48 : 64));
        process.exitCode = passed ? 0 : 1;
      } catch (error) {
        console.error(error); process.exitCode = 1;
      }
      res.end("ok");
      clearTimeout(timeout);
      server.close();
      child?.kill();
    });
    return;
  }
  if (sources[req.url]) {
    res.setHeader("Content-Type", "text/javascript");
    res.end(sources[req.url]);
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><body style="margin:0;background:#000000"><script type="module">(' +
    exercise.toString() + ')().then(result=>fetch("/result",{method:"POST",body:JSON.stringify(result)}))' +
    '.catch(error=>fetch("/result",{method:"POST",body:JSON.stringify({error:String(error)})}));</script>');
});
server.listen(0, "127.0.0.1", () => {
  child = spawn(browser, [
    "--headless", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking",
    "--user-data-dir=" + join(artifacts, "profile"),
    "--window-size=1000,800", "http://127.0.0.1:" + server.address().port,
  ], { windowsHide: true, stdio: "ignore" });
  child.on("error", (error) => {
    console.error(error); process.exitCode = 1; server.close(); clearTimeout(timeout);
  });
  timeout = setTimeout(() => {
    console.error("WebGL test timed out. Artifacts: " + artifacts);
    process.exitCode = 1; child.kill(); server.close();
  }, 90000);
});
