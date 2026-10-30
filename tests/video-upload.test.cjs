const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, PassThrough } = require("node:stream");
const { createVideoUploadStore } = require("../apps/api/src/video-upload-store.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.from("abcdefghij");
const manifest = (name = "video.mp4") => ({ fields: { sourceKind: "embedded", title: "Fixture" },
  files: [{ field: "video", name, size: bytes.length, type: "video/mp4", fingerprint: hash(bytes) }] });

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "resumable-video-"));
  const config = { root: path.join(temp, "private"), mediaRoot: path.join(temp, "media"),
    maxFileBytes: 100, maxCoverBytes: 50, maxTotalBytes: 200, quotaBytes: 1000,
    chunkBytes: 4, canProcess: () => false, processUpload: async () => ({ status: "ok" }), ...options };
  let store = createVideoUploadStore(config);
  await store.init();
  t.after(async () => { await store.close(); await fs.rm(temp, { recursive: true, force: true }); });
  return { temp, config, get store() { return store; }, async restart() {
    await store.close(); store = createVideoUploadStore(config); await store.init(); return store;
  } };
}
function request(body, offset, checksum = hash(body)) {
  const stream = Readable.from([body]);
  stream.headers = { "upload-offset": String(offset), "upload-checksum": checksum,
    "content-type": "application/octet-stream", "content-length": String(body.length) };
  return stream;
}
async function receive(store, id) {
  for (let offset = 0; offset < bytes.length; offset += 4) {
    await store.append(id, 0, request(bytes.subarray(offset, offset + 4), offset));
  }
}

test("manifest IDs are idempotent, reject rebinding, traversal and credential persistence", async t => {
  const { store } = await fixture(t);
  const id = crypto.randomUUID();
  assert.equal((await store.create(id, manifest())).id, id);
  assert.equal((await store.create(id, manifest())).id, id);
  await assert.rejects(store.create(id, manifest("other.mp4")), { statusCode: 409 });
  await assert.rejects(store.create(crypto.randomUUID(), manifest("../video.mp4")), { statusCode: 400 });
  await assert.rejects(store.create(crypto.randomUUID(), { ...manifest(), fields: { token: "secret" } }), { statusCode: 400 });
  await assert.rejects(store.create(crypto.randomUUID(), { ...manifest(), files: [{ ...manifest().files[0], size: 101 }] }), { statusCode: 400 });
});

test("checksums, exact chunk boundaries and duplicate offsets cannot corrupt confirmed bytes", async t => {
  const { store, config } = await fixture(t);
  const id = crypto.randomUUID(); await store.create(id, manifest());
  await assert.rejects(store.append(id, 0, request(bytes.subarray(0, 4), 0, "0".repeat(64))), { statusCode: 422 });
  assert.equal(store.status(id).files[0].offset, 0);
  await assert.rejects(store.append(id, 0, request(bytes.subarray(0, 3), 0)), { statusCode: 400 });
  await store.append(id, 0, request(bytes.subarray(0, 4), 0));
  await assert.rejects(store.append(id, 0, request(bytes.subarray(0, 4), 0)), { statusCode: 409 });
  assert.deepEqual(await fs.readFile(path.join(config.root, id, "0.bin")), bytes.subarray(0, 4));
  assert.deepEqual(store.receipts(id, 0).chunks, [hash(bytes.subarray(0, 4))]);
  await assert.rejects(store.complete(id), { statusCode: 409 });
});

test("task summaries expose confirmed upload progress without inventing encoder percentages", async t => {
  const { store } = await fixture(t);
  const id = crypto.randomUUID(); await store.create(id, manifest());
  assert.equal(store.taskSummaries()[0].progress, 0);
  await store.append(id, 0, request(bytes.subarray(0, 4), 0));
  assert.equal(store.taskSummaries()[0].progress, 40);
  await store.append(id, 0, request(bytes.subarray(4, 8), 4));
  await store.append(id, 0, request(bytes.subarray(8), 8));
  await store.complete(id);
  assert.equal(store.taskSummaries()[0].state, "queued");
  assert.equal(store.taskSummaries()[0].progress, null);
  assert.equal("files" in store.taskSummaries()[0], false);
});

test("aborted and concurrent chunks retain the last acknowledged offset", async t => {
  const { store } = await fixture(t);
  const id = crypto.randomUUID(); await store.create(id, manifest());
  const stream = new PassThrough(); stream.headers = request(bytes.subarray(0, 4), 0).headers;
  const pending = store.append(id, 0, stream);
  const rejected = assert.rejects(pending, /interrupted/);
  stream.write(bytes.subarray(0, 2));
  await assert.rejects(store.append(id, 0, request(bytes.subarray(0, 4), 0)), { statusCode: 409 });
  stream.destroy(new Error("interrupted")); await rejected;
  assert.equal(store.status(id).files[0].offset, 0);
  await receive(store, id);
  assert.equal(store.status(id).files[0].offset, bytes.length);
});

test("restart resumes confirmed chunks and removes an uncommitted tail before appending", async t => {
  const f = await fixture(t);
  const id = crypto.randomUUID(); await f.store.create(id, manifest());
  await f.store.append(id, 0, request(bytes.subarray(0, 4), 0));
  await fs.appendFile(path.join(f.config.root, id, "0.bin"), "uncommitted-tail");
  await f.restart();
  assert.equal(f.store.status(id).files[0].offset, 4);
  await f.store.append(id, 0, request(bytes.subarray(4, 8), 4));
  await f.store.append(id, 0, request(bytes.subarray(8), 8));
  assert.deepEqual(await fs.readFile(path.join(f.config.root, id, "0.bin")), bytes);
});

test("queued jobs survive restart; repeated completion does not repeat publishing", async t => {
  let enabled = false, calls = 0, release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { canProcess: () => enabled, async processUpload(parsed, checkpoint) {
    calls++; assert.deepEqual(await fs.readFile(parsed.file.tempPath), bytes);
    await checkpoint("processing"); entered(); await gate;
    await checkpoint("publishing"); return { status: "ok", project: { id: 9 } };
  } });
  const id = crypto.randomUUID(); await f.store.create(id, manifest()); await receive(f.store, id);
  assert.equal((await f.store.complete(id)).state, "queued");
  await f.restart(); assert.equal(f.store.status(id).state, "queued");
  enabled = true; const running = f.store.drain(); await started;
  assert.equal((await f.store.complete(id)).state, "processing");
  assert.equal((await f.store.create(id, manifest())).state, "processing");
  release(); await running;
  assert.equal((await f.store.complete(id)).state, "completed");
  assert.equal(calls, 1);
  await f.restart();
  assert.equal(f.store.status(id).result.project.id, 9);
});

test("recovery distinguishes safe processing, uncertain publication and saved primary results", async t => {
  const f = await fixture(t);
  const ids = {};
  for (const phase of ["processing", "publishing", "derivatives"]) {
    const id = ids[phase] = crypto.randomUUID();
    await f.store.create(id, manifest()); await receive(f.store, id);
    const filename = path.join(f.config.root, id, "session.json");
    const journal = JSON.parse(await fs.readFile(filename));
    await fs.writeFile(filename, JSON.stringify({ ...journal, state: "processing", phase,
      ...(phase === "derivatives" ? { result: { status: "ok", project: { id: 9 } } } : {}) }));
  }
  await f.restart();
  assert.equal(f.store.status(ids.processing).state, "queued");
  assert.equal(f.store.status(ids.publishing).state, "interrupted");
  assert.equal(f.store.status(ids.derivatives).state, "completed");
  assert.equal(f.store.status(ids.derivatives).result.processingInterrupted, true);
});

test("queue pressure retains completed bytes and maintenance prevents starting work", async t => {
  let enabled = false, attempts = 0;
  const f = await fixture(t, { canProcess: () => enabled, processUpload: async () => {
    attempts++; throw Object.assign(new Error("busy"), { statusCode: 503 });
  } });
  const id = crypto.randomUUID(); await f.store.create(id, manifest()); await receive(f.store, id);
  await f.store.complete(id); await f.store.drain(); assert.equal(attempts, 0);
  enabled = true; await f.store.drain();
  assert.equal(f.store.status(id).state, "queued");
  assert.equal(f.store.status(id).files[0].offset, bytes.length);
});

test("quota reservations, expiry and cancel are bounded without deleting queued jobs", async t => {
  let time = 0;
  const f = await fixture(t, { quotaBytes: 10, ttlMs: 100, now: () => time });
  const id = crypto.randomUUID(); await f.store.create(id, manifest());
  await assert.rejects(f.store.create(crypto.randomUUID(), manifest()), { statusCode: 503 });
  await f.store.cancel(id); await assert.rejects(f.store.append(id, 0, request(bytes.subarray(0, 4), 0)), { statusCode: 409 });
  time = 101;
  const next = crypto.randomUUID(); await f.store.create(next, manifest());
  assert.throws(() => f.store.status(id), { statusCode: 404 });
  await receive(f.store, next); await f.store.complete(next);
  time = 1000; await f.restart();
  assert.equal(f.store.status(next).state, "queued");
});

test("private storage rejects public paths and simultaneous API processes", async t => {
  const f = await fixture(t);
  const second = createVideoUploadStore(f.config);
  await assert.rejects(second.init(), /already being held/);
  await assert.rejects(createVideoUploadStore({ ...f.config, root: path.join(f.config.mediaRoot, "uploads") }).init(), /separate/);
});

test("paired same-name sources retain separate bytes and multipart roles", async t => {
  let enabled = false, received;
  const f = await fixture(t, { canProcess: () => enabled, async processUpload(parsed, checkpoint) {
    await checkpoint("processing");
    received = await Promise.all(parsed.files.videos.map(file => fs.readFile(file.tempPath, "utf8")));
    assert.equal(parsed.file, parsed.files.videos[0]);
    assert.equal(parsed.files.videos[0].originalName, parsed.files.videos[1].originalName);
    return { status: "ok" };
  } });
  const input = manifest();
  input.files = ["HDR", "SDR"].map(value => ({ ...input.files[0], size: 3, fingerprint: hash(value) }));
  const id = crypto.randomUUID(); await f.store.create(id, input);
  await f.store.append(id, 0, request(Buffer.from("HDR"), 0));
  await f.store.append(id, 1, request(Buffer.from("SDR"), 0));
  await f.store.complete(id); enabled = true; await f.store.drain();
  assert.deepEqual(received, ["HDR", "SDR"]);
});

test("cross-volume staging move preserves contents and never replaces an existing destination", async t => {
  const f = await fixture(t);
  const source = path.join(f.temp, "staging"), destination = path.join(f.temp, "saved");
  await fs.writeFile(source, bytes);
  // Inject EXDEV while exercising the real copy/sync/unlink fallback.
  t.mock.method(fs, "rename", async () => { throw Object.assign(new Error("Cross-device link"), { code: "EXDEV" }); });
  const { moveUploadFile } = require("../apps/api/src/resource-io.cjs");
  await moveUploadFile(source, destination);
  assert.deepEqual(await fs.readFile(destination), bytes);
  await assert.rejects(fs.access(source), { code: "ENOENT" });
  await fs.writeFile(source, "other");
  await assert.rejects(moveUploadFile(source, destination), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(destination), bytes);
  assert.equal(await fs.readFile(source, "utf8"), "other");
});
