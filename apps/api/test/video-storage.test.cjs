const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { Readable, Writable } = require("node:stream");
const { finished, pipeline } = require("node:stream/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createVideoStorage } = require("../src/video-storage.cjs");
const { canReadMedia } = require("../src/media-access.cjs");
const { startS3Fixture } = require("../../../tests/helpers/s3-fixture.cjs");
const { loadServer } = require("./helpers/imf-server.cjs");

async function fixture(t) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "video-oss-"));
  const root = path.join(temp, "media"), journal = path.join(temp, "private/video-oss");
  await fsp.mkdir(root);
  const stored = new Map(), uploads = [];
  const objectStore = {
    async upload({ key, filename, sha256, contentType }) {
      uploads.push(key);
      stored.set(key, { bytes: await fsp.readFile(filename), sha256, contentType });
    },
    async stat(key) {
      const object = stored.get(key);
      return object ? { size: object.bytes.length, sha256: object.sha256,
        etag: `"${object.sha256}"`, modified: new Date("2026-01-01T00:00:00Z") } : null;
    },
    async read(key, range) {
      const bytes = stored.get(key).bytes;
      return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]);
    }
  };
  const config = { mediaRoot: root, journalRoot: journal, objectStore, env: {
    VIDEO_STORAGE: "oss", VIDEO_OSS_BUCKET: "fixture-bucket", VIDEO_OSS_REGION: "cn-hangzhou",
    VIDEO_OSS_ENDPOINT: "https://s3.oss-cn-hangzhou.aliyuncs.com", VIDEO_OSS_KEY: "fixture-key", VIDEO_OSS_SECRET: "fixture-secret"
  } };
  const storage = createVideoStorage(config);
  await storage.init();
  t.after(async () => { await storage.close(); await fsp.rm(temp, { recursive: true, force: true }); });
  const write = async (relative, bytes) => {
    const filename = path.join(root, relative);
    await fsp.mkdir(path.dirname(filename), { recursive: true });
    await fsp.writeFile(filename, bytes);
    return filename;
  };
  return { root, journal, stored, uploads, storage, config, objectStore, write };
}

test("OSS configuration is opt-in and validates credentials, endpoint and object prefix", () => {
  assert.equal(createVideoStorage({}).enabled, false);
  assert.throws(() => createVideoStorage({ env: { VIDEO_STORAGE: "s3" } }), /VIDEO_STORAGE/);
  assert.throws(() => createVideoStorage({ env: { VIDEO_STORAGE: "oss" } }), /VIDEO_OSS_BUCKET/);
});

test("package sources and all HLS artifacts reach OSS before local eviction, without deleting another master", async t => {
  const f = await fixture(t);
  const sourcePath = await f.write("film/source-package/upload/video.mxf", "original");
  await f.write("film/source-package/upload/CPL.xml", "<CPL/>");
  await f.write("film/hdr/v1/segment.m4s", "segment");
  await f.write("film/hdr/v1/color-verification.json", "{}");
  const playlistPath = await f.write("film/hdr/v1/master.m3u8", "#EXTM3U\nsegment.m4s\n");
  const retained = await f.write("film/source/another-master.mp4", "unrelated");
  const publication = await f.storage.publish({ sourcePath, playlistPath, archiveDir: path.dirname(sourcePath) });
  assert.equal(publication.length, 5);
  assert.equal(f.uploads.at(-1), "blog_all/videos/film/hdr/v1/master.m3u8");
  assert.equal(await fsp.readFile(sourcePath, "utf8"), "original");
  assert.equal(await fsp.readFile(playlistPath, "utf8"), "#EXTM3U\nsegment.m4s\n");
  assert.equal(f.stored.get("blog_all/videos/film/source-package/upload/CPL.xml").bytes.toString(), "<CPL/>");
  assert.equal(await f.storage.complete([publication]), false);
  await assert.rejects(fsp.access(sourcePath), { code: "ENOENT" });
  await assert.rejects(fsp.access(playlistPath), { code: "ENOENT" });
  assert.equal(await fsp.readFile(retained, "utf8"), "unrelated");
  assert.deepEqual(await fsp.readdir(f.journal), []);
});

test("failed transfer and mismatching existing objects retain every local source", async t => {
  const f = await fixture(t);
  const sourcePath = await f.write("film/source/original.mp4", "source");
  const playlistPath = await f.write("film/sdr/v1/master.m3u8", "#EXTM3U");
  const upload = f.objectStore.upload;
  f.objectStore.upload = async () => { throw new Error("fixture offline"); };
  await assert.rejects(f.storage.publish({ sourcePath, playlistPath }), /fixture offline/);
  assert.equal(await fsp.readFile(sourcePath, "utf8"), "source");
  f.objectStore.upload = upload;
  f.stored.set("blog_all/videos/film/source/original.mp4", { bytes: Buffer.from("other"), sha256: "0".repeat(64) });
  await assert.rejects(f.storage.publish({ sourcePath, playlistPath }), { statusCode: 409 });
  assert.equal(await fsp.readFile(sourcePath, "utf8"), "source");
  assert.equal(await fsp.readFile(playlistPath, "utf8"), "#EXTM3U");
});

test("a failed OSS publication cannot create or update CMS records", async t => {
  const f = await fixture(t);
  const sourcePath = await f.write("film/source/original.mp4", "source");
  const playlistPath = await f.write("film/sdr/v1/master.m3u8", "#EXTM3U");
  f.objectStore.upload = async () => { throw new Error("fixture transfer failed"); };
  let cmsCalls = 0;
  const context = vm.createContext({ videoStorage: f.storage, directusLogin: () => { cmsCalls++; } });
  const source = fs.readFileSync(path.join(__dirname, "../src/server.cjs"), "utf8");
  vm.runInContext(source.match(/^async function createOrUpdateDirectusRecords\([\s\S]*?^}/m)[0], context);
  await assert.rejects(context.createOrUpdateDirectusRecords({}, sourcePath, playlistPath, {}, {}), /fixture transfer failed/);
  assert.equal(cmsCalls, 0);
  assert.equal(await fsp.readFile(sourcePath, "utf8"), "source");
});

test("the real video processing pipeline publishes verified HLS before CMS writes and evicts only after processing finishes", async t => {
  const f = await fixture(t);
  const ffmpeg = process.env.FFMPEG_PATH || require("ffmpeg-static");
  const ffprobe = process.env.FFPROBE_PATH || require("ffprobe-static").path;
  const temporary = path.join(f.root, "../incoming");
  await fsp.mkdir(temporary);
  const input = path.join(temporary, "source.mp4");
  await promisify(execFile)(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=10:duration=0.4",
    "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    "-chroma_sample_location", "left", "-c:a", "aac", input]);
  const original = await fsp.readFile(input);
  const api = loadServer(f.root, ffmpeg, ffprobe);
  api.videoStorage = f.storage;
  api.requireUploadAuth = () => {};
  const file = { filename: "source.mp4", originalName: "source.mp4", tempPath: input, mimeType: "video/mp4" };
  api.parseMultipart = async () => ({ tempDir: temporary, file, files: { video: file, videos: [file] },
    fields: { title: "Fixture", slug: "film", sourceKind: "embedded", masterType: "sdr", label: "SDR",
      mode: "copy", published: "true", isDefault: "true" } });
  api.directusLogin = async () => "fixture-token";
  api.directusUploadFile = async () => null;
  const masters = [];
  api.directusRequest = async (route, token, options) => {
    if (options?.method === "POST") {
      assert.ok(f.stored.size > 0, "OSS publication must precede any CMS mutation");
      if (route === "/items/video_projects") return { data: { id: 7, ...options.body } };
      const master = { id: 9, ...options.body }; masters.push(master); return { data: master };
    }
    return { data: route.startsWith("/items/video_masters?") ? masters : [] };
  };
  let status, payload;
  api.sendJson = (res, code, data) => { status = code; payload = data; };
  const phases = [];
  await api.handleUploadNow({ headers: {} }, { destroyed: false }, { checkpoint: async phase => {
    phases.push(phase);
    if (phase === "stored") assert.ok((await fsp.readdir(path.join(f.root, "film"))).length);
  } });
  assert.equal(status, 201, payload?.error);
  assert.equal(payload.storage, "oss");
  assert.equal(payload.localCleanupPending, false);
  assert.equal(payload.verification.status, "ready");
  assert.ok(phases.includes("stored"));
  assert.equal(masters.length, 1);
  assert.deepEqual(f.stored.get(`blog_all/videos/${payload.sourceUrl.slice("/media/".length)}`).bytes, original);
  assert.ok(f.stored.has(`blog_all/videos/${payload.hlsUrl.slice("/media/".length)}`));
  assert.deepEqual(await fsp.readdir(f.root), []);
});

test("cleanup verifies the whole publication and resumes its durable receipt after restart", async t => {
  const f = await fixture(t);
  const sourcePath = await f.write("film/source/original.mp4", "source");
  const playlistPath = await f.write("film/sdr/v1/master.m3u8", "#EXTM3U");
  const publication = await f.storage.publish({ sourcePath, playlistPath });
  const object = f.stored.get("blog_all/videos/film/source/original.mp4");
  object.sha256 = "0".repeat(64);
  assert.equal(await f.storage.complete([publication]), true);
  assert.equal(await fsp.readFile(playlistPath, "utf8"), "#EXTM3U");
  assert.equal(await fsp.readFile(sourcePath, "utf8"), "source");
  assert.equal((await fsp.readdir(f.journal)).length, 1);
  await f.storage.close();
  object.sha256 = crypto.createHash("sha256").update(object.bytes).digest("hex");
  const restarted = createVideoStorage(f.config);
  await restarted.init();
  await restarted.close();
  await assert.rejects(fsp.access(sourcePath), { code: "ENOENT" });
  await assert.rejects(fsp.access(playlistPath), { code: "ENOENT" });
});

test("a deferred receipt cannot remove different bytes restored at the original path", async t => {
  const f = await fixture(t);
  const sourcePath = await f.write("film/source/original.mp4", "original");
  const playlistPath = await f.write("film/sdr/v1/master.m3u8", "#EXTM3U");
  const receipt = await f.storage.publish({ sourcePath, playlistPath });
  const key = "blog_all/videos/film/source/original.mp4", remote = f.stored.get(key);
  f.stored.delete(key);
  assert.equal(await f.storage.complete([receipt]), true);
  await f.storage.close();
  await fsp.writeFile(sourcePath, "restored");
  f.stored.set(key, remote);
  const restarted = createVideoStorage(f.config);
  await restarted.init(); await restarted.close();
  assert.equal(await fsp.readFile(sourcePath, "utf8"), "restored");
  assert.equal(remote.bytes.toString(), "original");
  assert.equal((await fsp.readdir(f.journal)).length, 1);
});

test("immutable publication retries reuse matching objects and reject symlinks", async t => {
  const f = await fixture(t);
  const sourcePath = await f.write("film/source/original.mp4", "source");
  const playlistPath = await f.write("film/sdr/v1/master.m3u8", "#EXTM3U");
  await f.storage.publish({ sourcePath, playlistPath });
  await f.storage.publish({ sourcePath, playlistPath });
  assert.equal(f.uploads.length, 2);
  await fsp.symlink(sourcePath, path.join(path.dirname(playlistPath), "linked.mp4"));
  await assert.rejects(f.storage.publish({ sourcePath, playlistPath }), /symbolic links/);
});

class Reply extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.status = 0; }
  setHeader(name, value) { this.headers[name] = value; }
  hasHeader(name) { return Object.keys(this.headers).some(key => key.toLowerCase() === name.toLowerCase()); }
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }
  _write(chunk, encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
  bytes() { return Buffer.concat(this.chunks); }
}

function mediaHandler(f) {
  const source = fs.readFileSync(path.join(__dirname, "../src/server.cjs"), "utf8");
  let published = true;
  const context = vm.createContext({ fs, fsp, path, Buffer, AbortController, AbortSignal, pipeline,
    ...require("../src/http-utils.cjs"), ...require("../src/media-security.cjs"),
    MEDIA_ROOT: f.root, FILM_SCAN_ROOT: path.join(f.root, "../private/scans"), videoStorage: f.storage,
    JSON_COMPRESSION_MIN_BYTES: Infinity, TRUST_PROXY: false, PUBLIC_MEDIA_FILES: new Set(),
    assetAccess: () => ({}), assetBudget: { consume() {} }, assetSlots: { acquire: async () => () => {} },
    requestAddress: () => "fixture", directusLogin: async () => "fixture",
    directusRequest: async () => ({ data: published ? [{ hls_url: "/media/film/sdr/v1/master.m3u8", file_url: "/media/film/source/original.mp4" }] : [] }),
    canReadMedia
  });
  vm.runInContext(["handleMedia", "contentType", "cacheControl", "httpError", "sendJson"].map(name =>
    source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"))[0]).join("\n"), context);
  return { setPublished: value => { published = value; }, async request(relative, headers = {}, method = "GET") {
    const response = new Reply();
    await context.handleMedia({ method, headers }, `/media/${relative}`, response);
    await finished(response);
    return response;
  } };
}

test("evicted videos preserve /media playback, Range, HEAD and validators, with publication checks before OSS access", async t => {
  const f = await fixture(t);
  const sourcePath = await f.write("film/source/original.mp4", "0123456789");
  const playlistPath = await f.write("film/sdr/v1/master.m3u8", "#EXTM3U\nsegment.m4s\n");
  await f.write("film/sdr/v1/segment.m4s", "fragment");
  await f.storage.complete([await f.storage.publish({ sourcePath, playlistPath })]);
  const api = mediaHandler(f);
  const range = await api.request("film/source/original.mp4", { range: "bytes=2-5" });
  assert.equal(range.status, 206);
  assert.equal(range.bytes().toString(), "2345");
  assert.equal(range.headers["Content-Range"], "bytes 2-5/10");
  const head = await api.request("film/source/original.mp4", {}, "HEAD");
  assert.equal(head.status, 200); assert.equal(head.bytes().length, 0);
  assert.equal(head.headers["Content-Length"], 10);
  const notModified = await api.request("film/source/original.mp4", { "if-none-match": head.headers.ETag });
  assert.equal(notModified.status, 304);
  assert.equal((await api.request("film/source/original.mp4", { range: "bytes=10-" })).status, 416);
  assert.equal((await api.request("film/sdr/v1/segment.m4s")).bytes().toString(), "fragment");
  const read = f.objectStore.read;
  f.objectStore.read = async () => { throw Object.assign(new Error("fixture upstream unavailable"), { statusCode: 503 }); };
  assert.equal((await api.request("film/source/original.mp4")).status, 503);
  f.objectStore.read = read;
  const legacy = await f.write("film/source/legacy.mp4", "legacy");
  assert.ok(await fsp.stat(legacy));
  assert.equal((await api.request("film/source/legacy.mp4")).status, 404);
  api.setPublished(false);
  let cloudReads = 0;
  f.objectStore.stat = async () => { cloudReads++; throw new Error("must not contact OSS"); };
  assert.equal((await api.request("film/source/original.mp4", { "if-none-match": head.headers.ETag })).status, 404);
  assert.equal((await api.request("film/sdr/v1/segment.m4s")).status, 404);
  assert.equal((await api.request("film-scans/1/private.jpg")).status, 404);
  assert.equal((await api.request("../private/secret.mp4")).status, 404);
  assert.equal(cloudReads, 0);
});

test("real S3 SDK transfers multipart data with Content-MD5 and streams ranges without completed-object deletion", async t => {
  const cloud = await startS3Fixture();
  t.after(() => cloud.close());
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "video-s3-wire-"));
  const mediaRoot = path.join(temp, "media"), output = path.join(mediaRoot, "film/sdr/v1");
  await fsp.mkdir(output, { recursive: true });
  const sourcePath = path.join(mediaRoot, "film/original.mp4");
  const bytes = Buffer.alloc(8 * 1024 ** 2 + 31, 90);
  await fsp.writeFile(sourcePath, bytes);
  const playlistPath = path.join(output, "master.m3u8");
  await fsp.writeFile(playlistPath, "#EXTM3U");
  const storage = createVideoStorage({ mediaRoot, journalRoot: path.join(temp, "private"), env: {
    VIDEO_STORAGE: "oss", VIDEO_OSS_BUCKET: "fixture-bucket", VIDEO_OSS_REGION: "cn-hangzhou",
    VIDEO_OSS_ENDPOINT: cloud.endpoint, VIDEO_OSS_KEY: "fixture-key", VIDEO_OSS_SECRET: "fixture-secret"
  } });
  t.after(async () => { await storage.close(); await fsp.rm(temp, { recursive: true, force: true }); });
  await storage.init();
  const publication = await storage.publish({ sourcePath, playlistPath });
  assert.deepEqual(cloud.objects.get("blog_all/videos/film/original.mp4").bytes, bytes);
  assert.equal(cloud.calls.filter(call => call.method === "PUT" && call.multipart).length, 2);
  assert.equal(cloud.multipart.size, 0);
  assert.equal(await storage.complete([publication]), false);
  await assert.rejects(fsp.access(sourcePath), { code: "ENOENT" });
  assert.equal((await storage.stat("film/original.mp4")).size, bytes.length);
  const chunks = [];
  for await (const chunk of await storage.read("film/original.mp4", { start: 7, end: 12 })) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes.subarray(7, 13));
  assert.equal(cloud.calls.some(call => call.method === "DELETE" && !call.multipart), false);
  assert.deepEqual(cloud.errors, []);
});
