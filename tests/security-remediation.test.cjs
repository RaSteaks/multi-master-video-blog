const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { Writable } = require("node:stream");
const { finished, pipeline } = require("node:stream/promises");
const { createRequestBudget, requestAddress } = require("../apps/api/src/request-budget.cjs");
const { createAssetAuthorizer } = require("../apps/api/src/asset-access.cjs");
const { canReadMedia } = require("../apps/api/src/media-access.cjs");
const { createAnalyticsRecorder } = require("../apps/api/src/analytics-recorder.cjs");
const { createVideoUploadStore } = require("../apps/api/src/video-upload-store.cjs");
const { prepareCachedPreview } = require("../apps/api/src/preview-cache.cjs");
const { sqliteBatches } = require("../scripts/sqlite-batches.cjs");
const apiSource = fs.readFileSync(path.join(__dirname, "../apps/api/src/server.cjs"), "utf8");

// Execute production handlers with disposable files and controlled network effects.
function apiFixture(names, extra = {}) {
  const context = vm.createContext({ Buffer, URL, URLSearchParams, AbortSignal, pipeline,
    fs, fsp, path, ...require("../apps/api/src/http-utils.cjs"),
    ...require("../apps/api/src/media-security.cjs"), ...extra });
  vm.runInContext(names.map(name => {
    const match = apiSource.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name); return match[0];
  }).join("\n"), context);
  return context;
}
async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "blog-remediation-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true })); return dir;
}

test("request budgets bound rotating identities and ignore spoofed forwarding headers", () => {
  let now = 0;
  const budget = createRequestBudget({ limit: 3, perClient: 2, now: () => now });
  budget.consume("a"); budget.consume("a");
  assert.throws(() => budget.consume("a"), { statusCode: 429 });
  budget.consume("b"); assert.throws(() => budget.consume("c"), { statusCode: 429 });
  now = 60_000; assert.doesNotThrow(() => budget.consume("a"));
  const req = { headers: { "x-real-ip": "192.0.2.3", "x-forwarded-for": "spoofed" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(requestAddress(req), "127.0.0.1"); assert.equal(requestAddress(req, true), "192.0.2.3");
});

test("asset ownership hints reduce queries without caching publication grants", async () => {
  let published = true, calls = 0;
  const authorize = createAssetAuthorizer({ request: async route => {
    calls++;
    if (route.startsWith("/items/album_photos?")) return { data: published ? [{ id: 1 }] : [] };
    return { data: [] };
  } });
  assert.equal(await authorize("photo", {}), true); assert.equal(calls, 6);
  calls = 0;
  assert.equal(await authorize("photo", {}), true); assert.equal(calls, 1);
  published = false;
  assert.equal(await authorize("photo", {}), false);
  calls = 0; assert.equal(await authorize("photo", {}), false); assert.equal(calls, 0);
});

test("asset authorization shares simultaneous checks and keeps credentials separate", async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const authorize = createAssetAuthorizer({ request: async route => { calls++; await gate;
    return { data: route.includes("/albums?") ? [{ id: 1 }] : [] };
  } });
  const first = Array.from({ length: 20 }, () => authorize("same", {}));
  assert.equal(calls, 1); release(); await Promise.all(first); assert.equal(calls, 5);
  await authorize("same", { media: true }); assert.equal(calls, 10);
});

test("inline images reuse an indexed current owner and share its snapshot without stale grants", async () => {
  const calls = []; let published = true;
  const authorize = createAssetAuthorizer({ request: async route => {
    calls.push(route); const url = new URL(route, "http://fixture");
    if (url.pathname.startsWith("/files/")) return { data: { description: "article-image:00000000-0000-4000-8000-000000000001" } };
    if (url.pathname === "/items/posts" && url.searchParams.get("fields") === "id,content") {
      assert.equal(url.searchParams.get("limit"), "1");
      await new Promise(resolve => setImmediate(resolve));
      return { data: published ? [{ id: 7, content: "![a](/api/assets/a) ![b](/api/assets/b)" }] : [] };
    }
    return { data: [] };
  } });
  await authorize("a", {}); await authorize("b", {}); calls.length = 0;
  assert.deepEqual(await Promise.all([authorize("a", {}), authorize("b", {})]), [true, true]);
  const posts = calls.filter(route => route.startsWith("/items/posts"));
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(new URL(posts[0], "http://fixture").searchParams.get("filter")).id._eq, 7);
  published = false; assert.equal(await authorize("a", {}), false);
});

test("video authorization revokes segments and original downloads after unpublishing", async () => {
  let published = true;
  const request = async route => {
    const url = new URL(route, "http://fixture");
    assert.equal(url.searchParams.get("filter[project_id][published][_eq]"), "true");
    return { data: published ? [{ hls_url: "/media/film/sdr/v1/master.m3u8", file_url: "/media/film/source/original.mov" }] : [] };
  };
  for (const file of ["film/sdr/v1/master.m3u8", "film/sdr/v1/segment.ts", "film/source/original.mov"]) {
    assert.equal(await canReadMedia(file, {}, request), true);
  }
  assert.equal(await canReadMedia("film/source-package/private.xml", {}, request), false);
  published = false;
  assert.equal(await canReadMedia("film/sdr/v1/segment.ts", {}, request), false);
  assert.equal(await canReadMedia("film/source/original.mov", {}, request), false);
  assert.equal(await canReadMedia("film/source/original.mov", { media: true }, request), true);
});

test("media authorization handles Unicode source URLs and keeps archives out of root HLS grants", async () => {
  const request = async () => ({ data: [{ hls_url: "/media/film/master.m3u8?v=1", file_url: "/media/film/source-package/原片.mxf" }] });
  assert.equal(await canReadMedia("film/source-package/原片.mxf", {}, request), true);
  assert.equal(await canReadMedia("film/segment.TS", {}, request), true);
  assert.equal(await canReadMedia("film/source/unlisted.mp4", {}, request), false);
  assert.equal(await canReadMedia("film/SOURCE/unlisted.mp4", {}, request), false);
});

test("media disconnects close source descriptors for full and range requests", async t => {
  const dir = await temp(t); const pub = path.join(dir, "media"); await fsp.mkdir(pub);
  await fsp.writeFile(path.join(pub, "movie.mp4"), Buffer.alloc(1024 * 1024));
  const streams = [];
  const api = apiFixture(["handleMedia", "contentType", "cacheControl", "httpError", "sendJson"], {
    MEDIA_ROOT: pub, FILM_SCAN_ROOT: path.join(dir, "private"), PUBLIC_MEDIA_FILES: new Set(),
    assetAccess: () => ({}), canReadMedia: async () => true,
    assetBudget: { consume() {} }, requestAddress: () => "fixture", TRUST_PROXY: false,
    assetSlots: { acquire: async () => () => {} },
    JSON_COMPRESSION_MIN_BYTES: Infinity,
    fs: { ...fs, createReadStream(...args) { const stream = fs.createReadStream(...args); streams.push(stream); return stream; } }
  });
  for (const range of [undefined, "bytes=0-999999"]) {
    const res = new Writable({ write(chunk, encoding, done) { this.destroy(); done(); } });
    res.setHeader = res.writeHead = () => {};
    await api.handleMedia({ method: "GET", headers: { range } }, "/media/movie.mp4", res);
    await finished(streams.at(-1)).catch(() => {});
    assert.equal(streams.at(-1).destroyed, true); assert.equal(streams.at(-1).closed, true);
  }
  const chunks = [], missing = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
  missing.setHeader = missing.writeHead = () => {};
  await api.handleMedia({ method: "GET", headers: {} }, "/media/missing.mp4", missing);
  await finished(missing);
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).error, "Media file not found.");
  assert.equal(Buffer.concat(chunks).toString().includes(dir), false);
});

test("a slow asset reader releases admission after upstream headers", async () => {
  let released = 0, body;
  const response = new Response(new ReadableStream({ start(controller) { body = controller; } }), { headers: { "Content-Type": "image/jpeg" } });
  const api = apiFixture(["handleAsset", "httpError", "sendJson"], {
    AbortController, Readable: require("node:stream").Readable,
    DIRECTUS_URL: "http://fixture", ASSET_PRESETS: new Set(), TRUST_PROXY: false,
    assetAccess: () => ({}), requestAddress: () => "fixture", assetBudget: { consume() {} },
    assetSlots: { acquire: async () => () => { released++; } }, authorizeAsset: async () => true,
    directusLogin: async () => "fixture", fetchDirectusAsset: async () => response,
    JSON_COMPRESSION_MIN_BYTES: Infinity
  });
  const res = new Writable({ write(chunk, encoding, done) { done(); } });
  res.setHeader = res.writeHead = () => {};
  const work = api.handleAsset({ method: "GET", headers: {} }, new URL("http://fixture/assets/id"), res);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1); assert.equal(res.writableFinished, false);
  body.enqueue(new Uint8Array([255, 216, 255, 217])); body.close(); await work;
  assert.equal(released, 1);
});

function cmsFixture() {
  const data = { analytics_items: [], analytics_events: [] }, calls = [];
  let failCounter = false;
  const request = async (route, options = {}) => {
    calls.push(route);
    const url = new URL(route, "http://fixture"), [, , collection, id] = url.pathname.split("/");
    const table = data[collection];
    if (options.method === "POST") {
      const row = { id: table.length + 1, ...options.body }; table.push(row); return { data: structuredClone(row) };
    }
    if (options.method === "PATCH") {
      if (failCounter) { failCounter = false; throw new Error("CMS write unavailable"); }
      const row = table.find(row => String(row.id) === id); Object.assign(row, options.body); return { data: structuredClone(row) };
    }
    let rows = table.filter(row => [...url.searchParams].every(([key, value]) => {
      const match = key.match(/^filter\[(\w+)\]\[_(eq|gt|lte)\]$/);
      return !match || (match[2] === "eq" ? String(row[match[1]]) === value
        : match[2] === "lte" ? row[match[1]] <= Number(value) : row[match[1]] > Number(value));
    }));
    if (url.searchParams.has("aggregate[countDistinct]")) return { data: ["view", "play"].map(type => {
      const group = rows.filter(row => row.event_type === type);
      return { event_type: type, count: { id: group.length }, countDistinct: { visitor_hash: new Set(group.map(row => row.visitor_hash)).size } };
    }) };
    if (url.searchParams.has("aggregate[count]")) return { data: [{ count: { id: String(rows.length) } }] };
    if (url.searchParams.get("sort") === "-id") rows = [...rows].reverse();
    return { data: structuredClone(rows.slice(0, Number(url.searchParams.get("limit") || 100))) };
  };
  return { data, calls, request, failNextCounter() { failCounter = true; } };
}
const event = { itemType: "video", itemId: 7, eventType: "view", visitorHash: "visitor", path: "/videos/test" };
const item = { id: 7, title: "Test", slug: "test" };

test("analytics deduplicates concurrently and after restart, preserving exact incremental counters", async () => {
  const cms = cmsFixture(); let now = 1;
  const recorder = createAnalyticsRecorder({ request: cms.request, now: () => now });
  await Promise.all(Array.from({ length: 20 }, () => recorder.record(event, item)));
  assert.equal(cms.data.analytics_events.length, 1);
  assert.equal(cms.data.analytics_items[0].view_count, 1); assert.equal(cms.data.analytics_items[0].visitor_count, 1);
  const restarted = createAnalyticsRecorder({ request: cms.request, now: () => now });
  assert.equal((await restarted.record(event, item)).duplicate, true);
  now += 1_800_000; await restarted.record(event, item);
  await restarted.record({ ...event, eventType: "play", masterId: 3 }, item);
  const row = cms.data.analytics_items[0];
  assert.deepEqual([row.view_count, row.visitor_count, row.play_count, row.player_count], [2, 1, 1, 1]);
  assert.equal(cms.calls.some(route => route.includes("countDistinct")), false);
});

test("analytics recovers an inserted event after counter failure without counting it twice", async () => {
  const cms = cmsFixture(); const recorder = createAnalyticsRecorder({ request: cms.request, now: () => 1 });
  cms.failNextCounter(); await assert.rejects(recorder.record(event, item), /unavailable/);
  await recorder.record(event, item);
  assert.equal(cms.data.analytics_events.length, 1); assert.equal(cms.data.analytics_items[0].view_count, 1);
  await recorder.record(event, item); assert.equal(cms.data.analytics_items[0].view_count, 1);
});

test("analytics preserves legacy totals and rejects excess storage without deleting history", async () => {
  const cms = cmsFixture();
  cms.data.analytics_items.push({ id: 1, item_key: "video:7", view_count: 1000, visitor_count: 400, play_count: 8, player_count: 4 });
  cms.data.analytics_events.push({ id: 1, item_key: "video:7", event_type: "view", visitor_hash: "visitor" });
  const recorder = createAnalyticsRecorder({ request: cms.request, now: () => 1, maxEvents: 2 });
  await recorder.record(event, item);
  assert.equal(cms.data.analytics_items[0].view_count, 1001); assert.equal(cms.data.analytics_items[0].visitor_count, 400);
  await assert.rejects(recorder.record({ ...event, visitorHash: "new" }, item), { statusCode: 503 });
  assert.equal(cms.data.analytics_events.length, 2);
});

test("analytics baselines an old failed summary once before advancing its new cursor", async () => {
  const cms = cmsFixture();
  cms.data.analytics_items.push({ id: 1, item_key: "video:7", view_count: 1, visitor_count: 1 });
  for (let id = 1; id <= 3; id++) cms.data.analytics_events.push({ id, item_key: "video:7", event_type: "view", visitor_hash: `legacy-${id}` });
  const recorder = createAnalyticsRecorder({ request: cms.request, now: () => 1 });
  await recorder.record(event, item); await recorder.record(event, item);
  assert.equal(cms.data.analytics_items[0].view_count, 4); assert.equal(cms.data.analytics_items[0].visitor_count, 4);
  assert.equal(cms.calls.filter(route => route.includes("countDistinct")).length, 1);
});

test("403 is not retried as an expired token and public health hides diagnostics", async () => {
  let calls = 0;
  const api = apiFixture(["directusRequest", "httpError", "directusTransportError", "isDirectusMutationMethod", "handleHealth"], {
    DIRECTUS_URL: "http://fixture", fetch: async () => { calls++; return new Response('{"errors":[{"message":"Forbidden"}]}', { status: 403 }); },
    refreshDirectusLogin: () => { throw new Error("Must not refresh a forbidden credential"); },
    sendJson: (res, status, body) => { res.status = status; res.body = body; }
  });
  await assert.rejects(api.directusRequest("/items/restricted", "valid"), { directusHttpStatus: 403 });
  assert.equal(calls, 1);
  const res = {}; await api.handleHealth(res); assert.equal(JSON.stringify(res.body), '{"status":"ok"}');
});

test("legacy and resumable uploads share storage reservations", async t => {
  const dir = await temp(t), root = path.join(dir, "spool");
  const store = createVideoUploadStore({ root, mediaRoot: path.join(dir, "media"), maxFileBytes: 100, maxCoverBytes: 10,
    maxTotalBytes: 100, quotaBytes: 100, maxSessions: 2, processUpload: async () => ({}) });
  await store.init(); t.after(() => store.close());
  const release = await store.reserveLegacy(70);
  await assert.rejects(store.reserveLegacy(40), { statusCode: 503 });
  release(); const next = await store.reserveLegacy(100); next();
  await assert.rejects(store.reserveLegacy(101), { statusCode: 413 });
  const otherVolume = path.join(dir, "legacy-spool"), statfs = fsp.statfs;
  t.mock.method(fsp, "statfs", async filename => filename === otherVolume ? { bavail: 1, bsize: 4096 } : statfs(filename));
  await assert.rejects(store.reserveLegacy(10, otherVolume), { statusCode: 507 });
});

test("preview cache reuses density for color adjustments, invalidates crop and respects its byte bound", async t => {
  const dir = await temp(t), sourcePath = path.join(dir, "source.tif");
  await fsp.writeFile(sourcePath, "source"); let renders = 0;
  const prepare = async options => {
    renders++; const sourcePath = path.join(dir, "new-density.tif"); await fsp.writeFile(sourcePath, "density");
    return { sourcePath, temporaryPaths: [sourcePath], filmType: "slide" };
  };
  const options = { sourcePath, tempDir: dir, filmType: "color-negative", adjustments: { maskRgb: [1, 1, 1] }, crop: { x: 0 } };
  await prepareCachedPreview(options, prepare);
  await prepareCachedPreview({ ...options, adjustments: { ...options.adjustments, exposure: 1 } }, prepare);
  assert.equal(renders, 1);
  await prepareCachedPreview({ ...options, crop: { x: 1 } }, prepare); assert.equal(renders, 2);
  const uncached = await prepareCachedPreview({ ...options, crop: { x: 2 } }, prepare, 1);
  assert.equal(uncached.sourcePath, path.join(dir, "new-density.tif"));
});

test("SQLite migration batches bound memory and preserve composite-key ordering", async () => {
  const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:");
  try {
    db.exec("create table example(a integer, b integer, primary key(a,b))");
    for (let i = 0; i < 505; i++) db.prepare("insert into example values(?,?)").run(Math.floor(i / 5), i % 5);
    let count = 0, calls = 0;
    for await (const batch of sqliteBatches(async (sql, params) => { calls++; return db.prepare(sql).all(...params); }, "example", ["a", "b"])) {
      assert.ok(batch.length <= 200); count += batch.length;
    }
    assert.equal(count, 505); assert.equal(calls, 3);
  } finally { db.close(); }
});

test("CMS health shares login but still checks the authenticated health response", async () => {
  const filename = path.join(__dirname, "../scripts/directus-health.cjs");
  const module = { exports: {} }; let logins = 0, checks = 0, healthy = true;
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { require: createRequire(filename), module, __dirname: path.dirname(filename),
    AbortSignal, fetch: async url => {
      if (url.endsWith("/auth/login")) { logins++; await new Promise(resolve => setImmediate(resolve)); return Response.json({ data: { access_token: "fixture", expires: 900000 } }); }
      checks++; return Response.json({ status: healthy ? "ok" : "error" }, { status: healthy ? 200 : 503 });
    } });
  const check = () => module.exports.directusHealth({ ADMIN_EMAIL: "fixture@example.com", ADMIN_PASSWORD: "fixture" }, "http://fixture");
  await Promise.all(Array.from({ length: 10 }, check));
  assert.equal(logins, 1); assert.equal(checks, 10);
  healthy = false; await assert.rejects(check(), /503/); assert.equal(logins, 1);
});

test("CMS startup rejects every anonymous policy until explicit bootstrap seals app grants", async t => {
  const dir = await temp(t), filename = path.join(dir, "permissions.db");
  const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(filename);
  db.exec('create table directus_access(policy text, role text, user text); create table directus_permissions(id integer, policy text, collection text)');
  db.exec("insert into directus_access values ('public',null,null),('another-public',null,null),('service',null,'operator');");
  db.exec("insert into directus_permissions values (1,'public','posts'),(2,'another-public','directus_files'),(3,'service','posts'),(4,'public','unrelated');");
  db.close();
  const { directusPublicAccess } = require("../scripts/directus-public-access.cjs");
  const env = { DB_CLIENT: "sqlite3", DB_FILENAME: filename };
  await assert.rejects(directusPublicAccess(env), /Legacy anonymous/);
  await directusPublicAccess(env, { apply: true }); await directusPublicAccess(env);
  const result = new DatabaseSync(filename);
  try { assert.deepEqual(result.prepare("select id from directus_permissions order by id").all().map(row => row.id), [3,4]); }
  finally { result.close(); }
});
