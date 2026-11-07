const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Readable, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createAssetCache } = require("../src/asset-cache.cjs");
const { requestIsFresh } = require("../src/http-utils.cjs");

function fixture(options = {}) {
  const state = { reads: 0, fetches: 0, now: 0, body: "image-v1", status: 200,
    file: { modified_on: "2026-11-07T00:00:00.001Z", uploaded_on: "2026-11-07T00:00:00Z",
      filename_disk: "file.jpg", storage: "oss", type: "image/jpeg", filesize: "8", focal_point_x: null, focal_point_y: null } };
  const presets = [{ key: "thumb", width: 600, format: "webp" }];
  const cache = createAssetCache({
    presets, now: () => state.now,
    request: async () => { state.reads++; if (state.error) throw state.error; return { data: { ...state.file } }; },
    fetchAsset: async (id, preset, token, headers, method) => {
      state.fetches++;
      const body = `${state.body}${preset || ""}`;
      return new Response(method === "HEAD" ? null : body, { status: state.status,
        headers: { "content-type": preset ? "image/webp" : state.file.type, "content-length": String(Buffer.byteLength(body)),
          etag: '"coarse-upstream"', "last-modified": "Sat, 07 Nov 2026 00:00:00 GMT" } });
    },
    ...options
  });
  const get = (options = {}) => cache.get({ fileId: "file", preset: null, token: "service", ...options });
  return { state, presets, cache, get };
}

test("reuses bytes, checks current metadata, and revalidates browser ETags without reading origin", async () => {
  const f = fixture();
  const first = await f.get();
  const etag = first.response.headers.get("etag");
  assert.equal(first.cacheStatus, "MISS");
  assert.equal(await first.response.text(), "image-v1");
  assert.equal(first.response.headers.has("last-modified"), false);
  const hit = await f.get();
  assert.equal(hit.cacheStatus, "HIT");
  assert.equal(await hit.response.text(), "image-v1");
  const conditional = await f.get({ headers: { "if-none-match": etag } });
  assert.equal(conditional.response.status, 304);
  assert.equal(conditional.cacheStatus, "REVALIDATED");
  const head = await f.get({ method: "HEAD" });
  assert.equal(head.response.body, null);
  assert.equal(head.response.headers.get("content-length"), "8");
  assert.equal(f.state.fetches, 1);
  assert.equal(f.state.reads, 4);
  assert.equal(requestIsFresh({ "if-none-match": etag.replace(/^W\//, "") }, etag, NaN), true);
});

test("file replacements within one second, focal points and presets invalidate bytes and validators", async () => {
  const f = fixture();
  const first = await f.get();
  const etag = first.response.headers.get("etag");
  await first.response.text();
  f.state.file.modified_on = "2026-11-07T00:00:00.002Z";
  f.state.body = "image-v2";
  const changed = await f.get({ headers: { "if-none-match": etag } });
  assert.equal(changed.response.status, 200);
  assert.notEqual(changed.response.headers.get("etag"), etag);
  assert.equal(await changed.response.text(), "image-v2");
  const thumb = await f.get({ preset: "thumb" });
  const thumbEtag = thumb.response.headers.get("etag");
  assert.equal(await thumb.response.text(), "image-v2thumb");
  f.presets[0].width = 800;
  const resized = await f.get({ preset: "thumb", headers: { "if-none-match": thumbEtag } });
  assert.equal(resized.response.status, 200);
  assert.notEqual(resized.response.headers.get("etag"), thumbEtag);
  await resized.response.text();
  f.state.file.focal_point_x = 50;
  const recropped = await f.get({ preset: "thumb" });
  assert.equal(recropped.cacheStatus, "MISS");
  await recropped.response.text();
  assert.equal(f.state.fetches, 5);
});

test("CMS failures/deletions never fall back to cached bytes or a stale 304", async () => {
  const f = fixture();
  const first = await f.get();
  await first.response.text();
  for (const statusCode of [404, 503]) {
    f.state.error = Object.assign(new Error("CMS unavailable"), { statusCode });
    await assert.rejects(f.get({ headers: { "if-none-match": first.response.headers.get("etag") } }), { statusCode });
  }
  assert.equal(f.state.fetches, 1);
});

test("LRU, expiry and entry limits bound storage; expired bytes reload but matching browser bytes still validate", async () => {
  const f = fixture({ maxBytes: 16, maxEntryBytes: 8, ttlMs: 100 });
  for (const fileId of ["a", "b", "a", "c"]) await (await f.get({ fileId })).response.text();
  assert.equal(f.state.fetches, 3);
  await (await f.get({ fileId: "b" })).response.text();
  assert.equal(f.state.fetches, 4);
  f.state.now = 101;
  const expired = await f.get({ fileId: "b" });
  assert.equal(expired.cacheStatus, "MISS");
  const etag = expired.response.headers.get("etag");
  await expired.response.text();
  f.state.now = 202;
  assert.equal((await f.get({ fileId: "b", headers: { "if-none-match": etag } })).response.status, 304);
  assert.equal(f.state.fetches, 5);
  f.state.body = "large-original";
  for (let i = 0; i < 2; i++) {
    const large = await f.get({ fileId: "large" });
    assert.equal(large.cacheStatus, "BYPASS");
    assert.equal(await large.response.text(), "large-original");
  }
  assert.equal(f.state.fetches, 7);
});

test("private requests, non-images, incomplete metadata, failures and disabled caches are never retained", async () => {
  for (const scenario of ["private", "non-image", "metadata", "metadata-permission", "failure", "disabled"]) {
    const f = fixture(scenario === "disabled" ? { maxBytes: 0 } : {});
    if (scenario === "non-image") f.state.file.type = "text/html";
    if (scenario === "metadata") delete f.state.file.modified_on;
    if (scenario === "metadata-permission") f.state.error = Object.assign(new Error("Field forbidden"), { directusHttpStatus: 403 });
    if (scenario === "failure") f.state.status = 503;
    for (let i = 0; i < 2; i++) {
      const result = await f.get({ privateRequest: scenario === "private" });
      assert.equal(result.cacheStatus, "BYPASS", scenario);
      await result.response.text();
    }
    assert.equal(f.state.fetches, 2, scenario);
    if (["private", "disabled"].includes(scenario)) assert.equal(f.state.reads, 0);
  }
});

test("streams the first bytes immediately and coalesces simultaneous origin reads without holding admission", async () => {
  let stream, fetches = 0, released = 0;
  const f = fixture({ fetchAsset: async () => {
    fetches++;
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "image/jpeg" } });
  } });
  const first = await f.get();
  const reader = first.response.body.getReader();
  stream.enqueue(new TextEncoder().encode("first"));
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  const others = [f.get({ onWait: () => { released++; } }), f.get({ onWait: () => { released++; } })];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1);
  assert.equal(released, 2);
  stream.enqueue(new TextEncoder().encode("last"));
  stream.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "last");
  assert.equal((await reader.read()).done, true);
  for (const result of await Promise.all(others)) {
    assert.equal(result.cacheStatus, "COALESCED");
    assert.equal(await result.response.text(), "firstlast");
  }
  assert.equal(fetches, 1);
});

test("waiter cancellation is isolated; canceled or failed fills can retry without retaining partial bytes", async () => {
  const streams = [];
  const f = fixture({ fetchAsset: async () => new Response(new ReadableStream({ start(controller) { streams.push(controller); } }),
    { headers: { "content-type": "image/jpeg" } }) });
  const first = await f.get();
  const abort = new AbortController();
  const waiter = f.get({ signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(waiter, { name: "AbortError" });
  await first.response.body.cancel();
  const failed = await f.get();
  streams[1].error(new Error("disconnected"));
  await assert.rejects(failed.response.text(), /disconnected/);
  const retry = await f.get();
  streams[2].enqueue(new TextEncoder().encode("complete"));
  streams[2].close();
  assert.equal(await retry.response.text(), "complete");
  assert.equal(await (await f.get()).response.text(), "complete");
  assert.equal(streams.length, 3);
});

test("chunked images that exceed the limit continue streaming and do not enter the cache", async () => {
  let fetches = 0;
  const f = fixture({ maxEntryBytes: 2, fetchAsset: async () => {
    fetches++;
    return new Response("large", { headers: { "content-type": "image/jpeg" } });
  } });
  for (let i = 0; i < 2; i++) assert.equal(await (await f.get()).response.text(), "large");
  assert.equal(fetches, 2);
});

test("actual asset handler authorizes before cached bytes/304 and keeps previews out of shared caching", async () => {
  const f = fixture();
  let published = true;
  const context = vm.createContext({ Buffer, URL, AbortController, AbortSignal, Readable, pipeline,
    ...require("../src/http-utils.cjs"), ...require("../src/media-security.cjs"), assetCache: f.cache,
    ASSET_PRESETS: new Set(["thumb"]), TRUST_PROXY: false, JSON_COMPRESSION_MIN_BYTES: Infinity,
    assetAccess: req => ({ media: req.headers.authorization === "Bearer author" }),
    assetBudget: { consume() {} }, assetSlots: { acquire: async () => () => {} }, requestAddress: () => "fixture",
    directusLogin: async () => "service", authorizeAsset: async (id, access) => published || access.media });
  const source = fs.readFileSync(path.join(__dirname, "../src/server.cjs"), "utf8");
  for (const name of ["handleAsset", "httpError", "sendJson"]) {
    vm.runInContext(source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, "m"))[0], context);
  }
  async function get(headers = {}, method = "GET") {
    const chunks = [];
    const res = new Writable({ write(chunk, encoding, done) { chunks.push(chunk); done(); } });
    res.headers = {};
    res.setHeader = (key, value) => { res.headers[key] = value; };
    res.writeHead = (status, headers) => { res.status = status; Object.assign(res.headers, headers); };
    await context.handleAsset({ method, headers }, new URL("http://fixture/assets/file"), res);
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString() };
  }
  const first = await get();
  assert.equal(first.status, 200);
  assert.equal(first.headers["X-Asset-Cache"], "MISS");
  assert.match(first.headers.Vary, /X-Author-CSRF/);
  assert.equal((await get()).headers["X-Asset-Cache"], "HIT");
  const headers = { "if-none-match": first.headers.ETag };
  assert.equal((await get(headers)).status, 304);
  assert.equal(f.state.fetches, 1);
  published = false;
  for (const method of ["GET", "HEAD"]) {
    const denied = await get(headers, method);
    assert.equal(denied.status, 404);
    assert.equal(denied.headers["Cache-Control"], "private, no-store");
  }
  const preview = await get({ authorization: "Bearer author" });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers["X-Asset-Cache"], "BYPASS");
  assert.equal(preview.headers["Cache-Control"], "private, no-store");
  assert.equal(f.state.fetches, 2);
});
