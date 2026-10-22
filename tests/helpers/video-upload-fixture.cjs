const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const root = path.resolve(__dirname, "../..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Real API/Next/FFmpeg with an in-memory CMS and private disposable media. */
async function startFixture() {
  const output = path.join(root, "test-results/video-upload");
  await fsp.mkdir(output, { recursive: true });
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "video-upload-browser-"));
  const token = "isolated-video-upload-test";
  const collections = { video_projects: [], video_masters: [] };
  const stats = { patches: [], creates: 0, lostResponses: 0, rate: 0, loseNext: false };
  const children = [];
  const servers = [];
  const json = (res, data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data));
  };
  const cms = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/auth/login") return json(res, { data: { access_token: "fixture-cms", expires: 3600000 } });
      const [, , collection, id] = url.pathname.split("/");
      const rows = collections[collection] || [];
      if (req.method === "GET") {
        let selected = rows.filter(row => !id || String(row.id) === id);
        for (const [key, value] of url.searchParams) {
          const match = key.match(/^filter\[(\w+)\]\[_(eq|neq)\]$/);
          if (match) selected = selected.filter(row => match[2] === "eq"
            ? String(row[match[1]]) === value : String(row[match[1]]) !== value);
        }
        return json(res, { data: id ? selected[0] : selected });
      }
      let data = "";
      for await (const chunk of req) data += chunk;
      const body = data ? JSON.parse(data) : {};
      if (req.method === "POST") {
        const row = { ...body, id: rows.length + 1 }; rows.push(row);
        return json(res, { data: row });
      }
      const row = rows.find(item => String(item.id) === id);
      if (row) Object.assign(row, body);
      return json(res, { data: row || null });
    } catch (error) { json(res, { errors: [{ message: error.message }] }, 500); }
  });
  const listen = async (server, port) => {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    servers.push(server);
  };
  const start = (name, args, env) => {
    const log = fs.openSync(path.join(output, `${name}.log`), "w");
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env },
      stdio: ["ignore", log, log] });
    fs.closeSync(log); children.push(child); return child;
  };
  async function ready(url) {
    for (let i = 0; i < 120; i++) {
      try { const response = await fetch(url); if (response.ok) return; } catch { /* Wait for the isolated listener. */ }
      await delay(500);
    }
    throw new Error(`Fixture failed to start: ${url}`);
  }
  async function close() {
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue;
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(3000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fsp.rm(temp, { recursive: true, force: true });
  }
  try {
    await listen(cms, 18055);
    const apiEnv = { HOST: "127.0.0.1", PORT: "18060", DIRECTUS_URL: "http://127.0.0.1:18055",
      DIRECTUS_EMAIL: "fixture@example.invalid", DIRECTUS_PASSWORD: "fixture-only", UPLOAD_API_TOKEN: token,
      MEDIA_ROOT: path.join(temp, "media"), FILM_SCAN_ROOT: path.join(temp, "private/film"),
      VIDEO_UPLOAD_ROOT: path.join(temp, "private/video"), RESOURCE_PROFILE: "low-2gb",
      FFMPEG_PATH: process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg",
      FFPROBE_PATH: process.env.FFPROBE_PATH || "/opt/homebrew/bin/ffprobe" };
    start("fixture-api", ["apps/api/src/server.cjs"], apiEnv);
    await ready("http://127.0.0.1:18060/health");
    const proxy = http.createServer((req, res) => {
      const upload = req.method === "PATCH";
      if (req.method === "PUT") stats.creates++;
      if (upload) stats.patches.push({ offset: Number(req.headers["upload-offset"]), startedAt: Date.now() });
      const lose = upload && stats.loseNext;
      if (lose) stats.loseNext = false;
      const upstream = http.request({ hostname: "127.0.0.1", port: 18060, path: req.url,
        method: req.method, headers: req.headers }, response => {
        if (lose && response.statusCode === 200) {
          stats.lostResponses++; response.resume(); res.destroy(); return;
        }
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
      // Delay each actual request-body chunk; this constrains transport rather than faking progress events.
      const throttle = new Transform({ transform(chunk, encoding, done) {
        setTimeout(() => done(null, chunk), upload && stats.rate ? chunk.length / stats.rate * 1000 : 0);
      } });
      void pipeline(req, throttle, upstream).catch(() => upstream.destroy());
    });
    await listen(proxy, 18061);
    start("fixture-web", ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", "13000", "apps/web"],
      { API_INTERNAL_URL: "http://127.0.0.1:18061", DIRECTUS_URL: "http://127.0.0.1:18055",
        NEXT_PUBLIC_DIRECTUS_URL: "http://127.0.0.1:18055", DIRECTUS_EMAIL: "", DIRECTUS_PASSWORD: "",
        CMS_RUNTIME_ONLY: "true", RESOURCE_PROFILE: "low-2gb" });
    await ready("http://127.0.0.1:13000/upload");
    const video = path.join(temp, "weak-network.mp4");
    execFileSync(apiEnv.FFMPEG_PATH, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv420p",
      "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
      "-chroma_sample_location", "left", video]);
    return { output, temp, token, video, stats, collections, close, url: "http://127.0.0.1:13000/upload" };
  } catch (error) { await close(); throw error; }
}

module.exports = { startFixture };

if (require.main === module) startFixture().then(fixture => {
  console.log(JSON.stringify({ url: fixture.url, video: fixture.video, token: fixture.token }));
  process.on("SIGTERM", () => void fixture.close().then(() => process.exit()));
}).catch(error => { console.error(error); process.exitCode = 1; });
