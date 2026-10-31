// Opt-in integration: real Directus 12 + API against an exclusively temporary SQLite DB.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "test-results/security-remediation-2026-10-22/cms-integration");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = http.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
(async () => {
  await fsp.mkdir(output, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "blog-cms-security-"));
  const cmsPort = await port(), apiPort = await port(), webPort = await port();
  const cms = `http://127.0.0.1:${cmsPort}`, api = `http://127.0.0.1:${apiPort}`;
  const children = [], checks = [];
  let interrupted = false, stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const interrupt = () => { interrupted = true; stop(); for (const child of children) if (child.exitCode === null) child.kill("SIGTERM"); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  // Explicit environment prevents the repository's real connection settings leaking into a fixture.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(cmsPort), KEY: "isolated-integration-key",
    SECRET: "isolated-integration-secret-at-least-32-characters", DB_CLIENT: "sqlite3", DB_FILENAME: path.join(dir, "cms.db"),
    DB_CONNECTION_STRING: "", DATABASE_URL: "", DB_SSL: "false", DB_POOL__MIN: "1", DB_POOL__MAX: "1",
    ADMIN_EMAIL: "fixture@example.com", ADMIN_PASSWORD: "Fixture-Only-Password-2026!",
    PUBLIC_URL: cms, DIRECTUS_URL: cms, STORAGE_LOCATIONS: "local", STORAGE_LOCAL_DRIVER: "local",
    STORAGE_LOCAL_ROOT: path.join(dir, "uploads"), EXTENSIONS_PATH: path.join(dir, "extensions"),
    TELEMETRY: "false", UPDATE_CHECK: "false", WEBSOCKETS_ENABLED: "false", LOG_LEVEL: "info" };
  function start(name, args, overrides = {}, cwd = dir) {
    const log = fs.openSync(path.join(output, name + ".log"), "w");
    const child = spawn(process.execPath, ["--no-node-snapshot", ...args], { cwd, env: { ...env, ...overrides }, stdio: ["ignore", log, log] });
    fs.closeSync(log); children.push(child); return child;
  }
  async function command(name, args, overrides = {}, cwd) {
    const child = start(name, args, overrides, cwd);
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    try { const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
      assert.equal(code, 0, `${name} failed; see ${output}/${name}.log`);
    } finally { clearTimeout(timer); }
  }
  async function ready(url, child) {
    const deadline = Date.now() + 120_000;
    let last = "no response";
    while (Date.now() < deadline) {
      if (interrupted || child.exitCode !== null) throw new Error(`Server exited before ${url}`);
      try {
        if (url === cms + "/server/health") {
          await require("../scripts/directus-health.cjs").directusHealth(env, cms, 3000); return;
        }
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        last = `${response.status}: ${(await response.text()).slice(0, 400)}`;
        if (response.ok) return;
      } catch (error) { last = error.message; }
      await delay(250);
    }
    throw new Error(`Fixture did not become ready: ${url}: ${last}`);
  }
  async function close() {
    for (const child of children.reverse()) {
      if (child.exitCode !== null) continue;
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1500)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
  try {
    await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "isolated-security-fixture", private: true }));
    await fsp.mkdir(env.STORAGE_LOCAL_ROOT); await fsp.mkdir(env.EXTENSIONS_PATH);
    const cli = path.join(root, "node_modules/directus/cli.js");
    await command("bootstrap", [path.join(root, "scripts/run-service.cjs"), "bootstrap"], { SERVICE_CWD: dir, DIRECTUS_CLI: cli });
    const cmsChild = start("cms", [path.join(root, "scripts/run-service.cjs"), "cms"], { SERVICE_CWD: dir, DIRECTUS_CLI: cli }); await ready(cms + "/server/health", cmsChild);
    await command("schema", [path.join(root, "scripts/setup-directus-schema.cjs")]);
    checks.push("Directus bootstrap and schema succeed on an empty isolated database");
    let token;
    async function request(route, method = "GET", body) {
      const response = await fetch(cms + route, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await response.json();
      assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(json)}`);
      return json.data;
    }
    token = (await request("/auth/login", "POST", { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })).access_token;
    const album = await request("/items/albums", "POST", { title: "隔离测试相簿", slug: "fixture-album", published: true });
    const image = await require("sharp")({ create: { width: 48, height: 64, channels: 3, background: "#79838a" } }).png().toBuffer();
    const form = new FormData(); form.append("file", new Blob([image], { type: "image/png" }), "fixture.png");
    const uploaded = await fetch(cms + "/files", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    assert.equal(uploaded.status, 200); const file = (await uploaded.json()).data;
    await request("/items/album_photos", "POST", { album_id: album.id, sdr_image: file.id, published: true, sort_order: 0 });
    const post = await request("/items/posts", "POST", { title: "Published fixture", slug: "fixture-post", content: "Fixture", published: true });
    const project = await request("/items/video_projects", "POST", { title: "Video fixture", slug: "film", published: true });
    await request("/items/video_masters", "POST", { project_id: project.id, label: "SDR", type: "sdr",
      hls_url: "/media/film/sdr/v1/master.m3u8", status: "ready", verification_status: "ready", is_default: true });
    const media = path.join(dir, "media"); await fsp.mkdir(path.join(media, "film/sdr/v1"), { recursive: true });
    await fsp.writeFile(path.join(media, "film/sdr/v1/master.m3u8"), "#EXTM3U\n");
    const apiChild = start("api", [path.join(root, "apps/api/src/server.cjs")], { PORT: String(apiPort),
      DIRECTUS_EMAIL: env.ADMIN_EMAIL, DIRECTUS_PASSWORD: env.ADMIN_PASSWORD, UPLOAD_API_TOKEN: "fixture-upload",
      ARTICLE_API_TOKEN: "fixture-article", MEDIA_ROOT: media, FILM_SCAN_ROOT: path.join(dir, "film-private"),
      VIDEO_UPLOAD_ROOT: path.join(dir, "video-private"), FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg", FFPROBE_PATH: "/opt/homebrew/bin/ffprobe" });
    await ready(api + "/health", apiChild);
    assert.deepEqual(await (await fetch(api + "/health")).json(), { status: "ok" });
    assert.equal((await fetch(cms + "/items/albums")).status, 403);
    assert.equal((await fetch(cms + `/assets/${file.id}`)).status, 403);
    checks.push("Anonymous CMS collections/files denied; public health is minimal");
    const headers = { Authorization: "Bearer fixture-upload" };
    const listing = await (await fetch(api + "/albums/manage", { headers })).json();
    assert.equal(listing.albums[0].photoCount, 1); assert.equal(listing.albums[0].photos.length, 0);
    const detail = await (await fetch(api + `/albums/${album.id}/manage`, { headers })).json();
    assert.equal(detail.album.photos[0].width, 48); assert.equal(detail.album.photos[0].height, 64);
    checks.push("Album summaries use real CMS aggregation; selected detail retains image geometry");
    assert.equal((await fetch(api + `/assets/${file.id}`)).status, 200);
    await request(`/items/albums/${album.id}`, "PATCH", { published: false });
    assert.equal((await fetch(api + `/assets/${file.id}`)).status, 404);
    assert.equal((await fetch(api + `/assets/${file.id}`, { headers })).status, 200);
    await request(`/items/albums/${album.id}`, "PATCH", { published: true });
    checks.push("Asset ownership hints still revoke anonymous access immediately");
    const original = await fetch(api + "/media/film/sdr/v1/master.m3u8"); assert.equal(original.status, 200);
    await original.arrayBuffer(); await request(`/items/video_projects/${project.id}`, "PATCH", { published: false });
    assert.equal((await fetch(api + "/media/film/sdr/v1/master.m3u8", { headers: { "If-None-Match": original.headers.get("etag") } })).status, 404);
    checks.push("Unpublishing revokes conditional media requests");
    for (let i = 0; i < 3; i++) {
      const r = await fetch(api + "/analytics/events", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemType: "post", itemId: post.id, eventType: "view", visitorId: "one-fixture-visitor" }) });
      assert.equal(r.status, 202, await r.text());
    }
    const stats = await request("/items/analytics_items");
    assert.equal(stats[0].view_count, 1); assert.equal(stats[0].visitor_count, 1);
    checks.push("Persistent analytics dedupe and cursor counters work against real Directus");
    if (process.env.HOLD_FIXTURE === "1") {
      const web = `http://127.0.0.1:${webPort}`;
      const child = start("web", [path.join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(webPort)], {
        NODE_ENV: "development", PORT: String(webPort), DIRECTUS_EMAIL: env.ADMIN_EMAIL, DIRECTUS_PASSWORD: env.ADMIN_PASSWORD,
        DIRECTUS_SHOW_DRAFTS: "false", DIRECTUS_REVALIDATE: "0", API_INTERNAL_URL: api, NEXT_TELEMETRY_DISABLED: "1"
      }, path.join(root, "apps/web"));
      await ready(web, child);
      await fsp.writeFile(path.join(output, "fixture.json"), JSON.stringify({ cms, api, web, albumId: album.id, token: "fixture-upload" }, null, 2));
      console.log("Fixture ready for browser checks:", web);
      await stopped;
    }
  } finally {
    await fsp.writeFile(path.join(output, "report.json"), JSON.stringify({ checks }, null, 2));
    await close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
