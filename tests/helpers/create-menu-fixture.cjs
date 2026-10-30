const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const busboy = require("busboy");
const sharp = require("sharp");
const root = path.resolve(__dirname, "../..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Real Next rewrites/API with a disposable CMS, ports and media tree. */
async function startFixture({ name = "create-menu", cmsPort = 18057, apiPort = 18062, webPort = 13002 } = {}) {
  const output = path.join(root, "test-results", name);
  const cmsUrl = `http://127.0.0.1:${cmsPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  await fsp.mkdir(output, { recursive: true });
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "create-menu-"));
  await fsp.writeFile(path.join(output, "tsconfig.json"), JSON.stringify({
    extends: "../../apps/web/tsconfig.json",
    include: ["../../apps/web/src/**/*.ts", "../../apps/web/src/**/*.tsx", "../../apps/web/next-env.d.ts"],
  }));
  const token = "isolated-author-session-fixture";
  const unavailableCollections = new Set();
  const collections = {
    albums: [{ id: 1, title: "验收相簿", slug: "fixture-album", description: "隔离测试数据", published: true, photos: [] }],
    album_photos: [], video_projects: [], video_masters: [], external_projects: [], files: [], film_scan_jobs: [], film_scan_sources: [], film_scan_frames: [],
    posts: [{ id: 1, title: "验收文章", slug: "fixture-post", published: true,
      content: "## 第一节\n\n" + "阅读段落。\n\n".repeat(80) + "## 第二节\n\n结束。" }],
  };
  const children = [];
  const fileBytes = new Map();
  const servers = [];
  const json = (res, data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  const cms = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/auth/login") return json(res, { data: { access_token: "fixture-cms", expires: 3600000 } });
      if (url.pathname === "/files" && req.method === "POST") {
        const fields = {}; let bytes = Buffer.alloc(0); let info;
        const parser = busboy({ headers: req.headers });
        parser.on("field", (name, value) => { fields[name] = value; });
        parser.on("file", (name, stream, metadata) => { info = metadata; stream.on("data", chunk => { bytes = Buffer.concat([bytes, chunk]); }); });
        await new Promise((resolve, reject) => { parser.on("close", resolve); parser.on("error", reject); req.pipe(parser); });
        const dimensions = await sharp(bytes).metadata();
        const file = { ...fields, id: randomUUID(), filename_download: info.filename, type: info.mimeType,
          width: dimensions.width, height: dimensions.height };
        collections.files.push(file); fileBytes.set(file.id, bytes); return json(res, { data: file });
      }
      if (url.pathname.startsWith("/assets/")) {
        const id = url.pathname.split("/")[2];
        const bytes = fileBytes.get(id);
        if (!bytes) return json(res, {}, 404);
        const transformed = url.searchParams.has("key") ? await sharp(bytes).webp().toBuffer() : bytes;
        res.writeHead(200, { "Content-Type": url.searchParams.has("key") ? "image/webp" : "image/png" }); res.end(transformed); return;
      }
      const parts = url.pathname.split("/");
      const collection = parts[1] === "files" ? "files" : parts[2];
      const id = parts[1] === "files" ? parts[2] : parts[3];
      if (collection === "site_settings") return json(res, { data: null });
      if (unavailableCollections.has(collection)) return json(res, { error: "Fixture CMS unavailable" }, 503);
      const rows = collections[collection] || [];
      if (req.method === "GET") {
        let selected = rows.filter(row => !id || String(row.id) === id);
        function matches(row, filter) {
          return Object.entries(filter).every(([key, value]) => {
            if (key === "_or") return value.some(part => matches(row, part));
            if (key === "_and") return value.every(part => matches(row, part));
            if (key === "_eq") return String(row) === String(value);
            if (key === "_in") return value.map(String).includes(String(row));
            if (key === "_contains") return String(row || "").includes(value);
            if (key === "_null") return (row == null) === value;
            const child = key === "album_id" && !Object.keys(value).some(key => key.startsWith("_"))
              ? collections.albums.find(album => album.id === row.album_id) : row?.[key];
            return matches(child, value);
          });
        }
        if (url.searchParams.has("filter")) selected = selected.filter(row => matches(row, JSON.parse(url.searchParams.get("filter"))));
        for (const [key, value] of url.searchParams) {
          const match = key.match(/^filter\[(\w+)\]\[_(eq|in|neq)\]$/);
          if (match) selected = selected.filter(row => match[2] === "in" ? value.split(",").includes(String(row[match[1]]))
            : match[2] === "neq" ? String(row[match[1]]) !== value : String(row[match[1]]) === value);
        }
        if (url.searchParams.has("aggregate[count]")) {
          const groups = new Map();
          for (const row of selected) {
            const key = `${row.album_id}:${row.published}`;
            const group = groups.get(key) || { album_id: row.album_id, published: row.published, count: { id: 0, hdr_image: 0 } };
            group.count.id++; if (row.hdr_image) group.count.hdr_image++; groups.set(key, group);
          }
          return json(res, { data: [...groups.values()] });
        }
        if (collection === "albums") selected = selected.map(row => ({ ...row, photos: collections.album_photos.filter(photo => photo.album_id === row.id) }));
        if (collection === "external_projects" && !id) {
          selected.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || b.id - a.id);
          const offset = Number(url.searchParams.get("offset") || 0);
          selected = selected.slice(offset, offset + Number(url.searchParams.get("limit") || 100));
        }
        return json(res, { data: id ? selected[0] : selected });
      }
      let body = ""; for await (const chunk of req) body += chunk;
      const data = body ? JSON.parse(body) : {};
      if (req.method === "POST") { const row = { ...data, id: rows.length + 1 }; rows.push(row); return json(res, { data: row }); }
      const row = rows.find(item => String(item.id) === id);
      if (req.method === "DELETE") { if (row) rows.splice(rows.indexOf(row), 1); fileBytes.delete(id); return json(res, { data: null }); }
      if (row) Object.assign(row, data);
      json(res, { data: row || null });
    } catch (error) { json(res, { errors: [{ message: error.message }] }, 500); }
  });
  async function listen(server, port) {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    servers.push(server);
  }
  function start(name, args, env) {
    const log = fs.openSync(path.join(output, `${name}.log`), "a");
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", log, log] });
    fs.closeSync(log); children.push(child); return child;
  }
  async function ready(url) {
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* The isolated server is still starting. */ }
      await delay(500);
    }
    throw new Error(`Fixture failed to start: ${url}`);
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); }
  }
  async function close() {
    for (const child of children.toReversed()) await stop(child);
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fsp.rm(temp, { recursive: true, force: true });
  }
  let api;
  const apiEnv = { HOST: "127.0.0.1", PORT: String(apiPort), DIRECTUS_URL: cmsUrl,
    DIRECTUS_EMAIL: "fixture@example.invalid", DIRECTUS_PASSWORD: "fixture-only", UPLOAD_API_TOKEN: token,
    ARTICLE_API_TOKEN: "", TRUST_PROXY: "true", MEDIA_ROOT: path.join(temp, "media"),
    FILM_SCAN_ROOT: path.join(temp, "film"), VIDEO_UPLOAD_ROOT: path.join(temp, "video"), RESOURCE_PROFILE: "low-2gb" };
  const envFile = path.join(temp, "album-test.env");
  await fsp.writeFile(envFile, Object.entries({ ...apiEnv, API_URL: apiUrl, WEB_URL: webUrl })
    .map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
  async function restartApi(overrides = {}) {
    Object.assign(apiEnv, overrides);
    if (api) await stop(api);
    api = start("api", ["apps/api/src/server.cjs"], apiEnv);
    await ready(`${apiUrl}/health`);
  }
  try {
    await listen(cms, cmsPort);
    await restartApi();
    start("web", ["node_modules/next/dist/bin/next", "dev", "--webpack", "-H", "127.0.0.1", "-p", String(webPort), "apps/web"], {
      NEXT_DIST_DIR: `../../test-results/${name}/next`, API_INTERNAL_URL: apiUrl,
      NEXT_TSCONFIG_PATH: `../../test-results/${name}/tsconfig.json`,
      DIRECTUS_URL: cmsUrl, NEXT_PUBLIC_DIRECTUS_URL: cmsUrl,
      DIRECTUS_EMAIL: "", DIRECTUS_PASSWORD: "", CMS_RUNTIME_ONLY: "true", RESOURCE_PROFILE: "low-2gb",
    });
    await ready(`${webUrl}/albums`);
    // Compile navigation targets before opening a browser so dev HMR does not
    // interrupt the workflow while an unrelated optional viewer bundle builds.
    await ready(`${webUrl}/posts/fixture-post`);
    await ready(`${webUrl}/upload`);
    await ready(`${webUrl}/write`);
    await ready(`${webUrl}/albums/fixture-album`);
    for (const route of ["/", "/studio", "/project", "/posts", "/videos"]) await ready(`${webUrl}${route}`);
    return { output, temp, token, collections, unavailableCollections, close, restartApi, envFile, url: webUrl, apiUrl, cmsUrl };
  } catch (error) { await close(); throw error; }
}

module.exports = { startFixture };
