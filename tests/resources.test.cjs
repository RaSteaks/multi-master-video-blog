const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { AsyncLocalStorage } = require("node:async_hooks");
const { spawn } = require("node:child_process");
const { loadEnvironment, resolveResourceProfile } = require("../config/resource-profile.cjs");
const { createTaskLimiter } = require("../apps/api/src/task-limiter.cjs");
const { downloadToFile, mediaThreadArgs } = require("../apps/api/src/resource-io.cjs");

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-resources-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
// Extract actual server functions with isolated I/O; never start the user's API/CMS.
async function fixture(names, deps = {}, declarations = "") {
  const source = await fs.readFile(path.join(__dirname, "../apps/api/src/server.cjs"), "utf8");
  const context = vm.createContext({ Buffer, setTimeout, clearTimeout, setImmediate, AbortController,
    mediaContext: new AsyncLocalStorage(), resourceLimits: resolveResourceProfile({ RESOURCE_PROFILE: "low-2gb" }),
    maintenanceMode: false, ...deps });
  vm.runInContext(declarations + names.map(name => {
    const found = source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(found, name); return found[0];
  }).join("\n"), context);
  return context;
}

test("profiles are opt-in, CPU-aware and reject invalid settings", () => {
  assert.equal(resolveResourceProfile({}, 8).enabled, false);
  const small = resolveResourceProfile({ RESOURCE_PROFILE: "low-2gb" }, 1);
  assert.deepEqual(small.heap, { web: 256, api: 256, cms: 384, build: 1024 });
  assert.equal(small.maxPixels, 24000000);
  const medium = resolveResourceProfile({ RESOURCE_PROFILE: "low-4gb", SHARP_CACHE_MIB: "0", API_HEAP_MIB: "600" }, 1);
  assert.equal(medium.ffmpegThreads, 1);
  assert.equal(medium.sharpCacheMiB, 0);
  assert.equal(medium.heap.api, 600);
  for (const env of [{ RESOURCE_PROFILE: "typo" }, { FFMPEG_THREADS: "NaN" }, { FILM_SCAN_MAX_PIXELS: "-1" }, { MEDIA_PROCESS_CONCURRENCY: "1.5" }, { DB_POOL__MIN: "5", DB_POOL__MAX: "2" }]) {
    assert.throws(() => resolveResourceProfile(env));
  }
});

test("process environment overrides quoted file values and missing files are optional", async t => {
  const filename = path.join(await directory(t), ".env");
  await fs.writeFile(filename, 'RESOURCE_PROFILE=low-4gb\nHOST="127.0.0.1"\n');
  const env = loadEnvironment(filename, { RESOURCE_PROFILE: "low-2gb" });
  assert.equal(env.RESOURCE_PROFILE, "low-2gb"); assert.equal(env.HOST, "127.0.0.1");
  assert.deepEqual(loadEnvironment(filename + "-missing", { PORT: "8060" }), { PORT: "8060" });
  assert.equal(require("../scripts/directus-db-utils.cjs").loadDirectusEnv(filename + "-missing").DB_CLIENT, process.env.DB_CLIENT);
});

test("admission bounds foreground waiters, retains background work and removes cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slots = createTaskLimiter({ maxPending: 1, waitMs: 100 });
  const first = await slots.acquire();
  const controller = new AbortController();
  const canceled = assert.rejects(slots.acquire({ signal: controller.signal }), /cancel/);
  const background = slots.acquire({ background: true });
  await assert.rejects(slots.acquire(), { statusCode: 503 });
  controller.abort(new Error("cancel")); await canceled;
  const expired = assert.rejects(slots.acquire(), { statusCode: 503 });
  t.mock.timers.tick(101); await expired;
  assert.equal(slots.snapshot().pending, 1);
  first(); first();
  const release = await background;
  assert.equal(slots.snapshot().active, 1);
  release(); assert.equal(slots.snapshot().active, 0);
});

test("video and film HTTP entries share admission and queued disconnects never start work", async () => {
  const slots = createTaskLimiter({ maxPending: 4 });
  let finish, started;
  const entered = new Promise(resolve => { started = resolve; });
  let filmCalls = 0;
  const api = await fixture(["httpError", "withMediaRequest", "handleUpload", "handleAlbumRoute"], {
    mediaProcessingSlots: slots, requireUploadAuth() {}, requireAlbumAuth() {}, sendJson() {},
    // Multipart reception now precedes shared processing admission.
    parseMultipart: async () => ({}),
    handleUploadNow: () => new Promise(resolve => { finish = resolve; started(); }),
    handleAlbumRouteNow: async () => { filmCalls++; }
  });
  const video = api.handleUpload({}, new EventEmitter());
  await entered;
  const response = new EventEmitter();
  const film = api.handleAlbumRoute({ method: "POST" }, response, { pathname: "/albums/1/film-scans/1/commit" });
  assert.equal(slots.snapshot().pending, 1); assert.equal(filmCalls, 0);
  response.emit("close"); await film;
  assert.equal(slots.snapshot().pending, 0);
  finish(); await video;
  await api.handleAlbumRoute({ method: "POST" }, new EventEmitter(), { pathname: "/albums/1/film-scans/1/commit" });
  assert.equal(filmCalls, 1); assert.equal(slots.snapshot().active, 0);
  api.maintenanceMode = true;
  await api.handleUpload({}, new EventEmitter());
  assert.equal(slots.snapshot().active, 0);
});

test("durable film worker waits for shared admission and releases after analysis", async () => {
  const slots = createTaskLimiter({ waitMs: 10 });
  const held = await slots.acquire();
  let analyzed = false, released = false;
  const api = await fixture(["drainFilmScanQueue"], {
    mediaProcessingSlots: slots, filmScanQueue: ["42"], activeFilmScanJobId: null,
    registerFilmScanController: () => new AbortController(),
    releaseFilmScanController: () => { released = true; },
    withFilmScanTimeout: (fn, label, controller) => fn(controller.signal),
    analyzeFilmScanJob: async () => { analyzed = true; },
    console, cleanupFilmScanJobAssets: async () => {},
  });
  const work = api.drainFilmScanQueue();
  assert.equal(analyzed, false); assert.equal(slots.snapshot().pending, 1);
  held(); await work;
  assert.equal(analyzed, true); assert.equal(released, true); assert.equal(slots.snapshot().active, 0);
});

test("thread options scope both decoding and encoding without changing codecs", () => {
  const args = mediaThreadArgs(["-y", "-i", "input", "-c:v", "copy", "out.mp4"], 1);
  assert.ok(args.indexOf("-threads") < args.indexOf("-i"));
  assert.deepEqual(args.slice(-3), ["-threads", "1", "out.mp4"]);
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.deepEqual(mediaThreadArgs(["-version"], 1), ["-version"]);
  assert.deepEqual(mediaThreadArgs(["-show_streams", "input"], 1, true).slice(0, 2), ["-threads", "1"]);
});

test("process output is bounded, timeout waits for child close, and diagnostics retain their tail", async () => {
  let closed = false;
  const api = await fixture(["runProcess", "httpError"], {
    spawn: (...args) => { const child = spawn(...args); child.on("close", () => { closed = true; }); return child; },
    path, REPO_ROOT: os.tmpdir(), FFPROBE_PATH: "ffprobe", VIDEO_PROCESS_TIMEOUT_MS: 1000,
    mediaThreadArgs, resourceLimits: { ffmpegThreads: 0, processOutputBytes: 1024, processLogBytes: 32 }
  });
  await assert.rejects(api.runProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)']), { statusCode: 502 });
  assert.equal(closed, true); closed = false;
  await assert.rejects(api.runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 }), { statusCode: 504 });
  assert.equal(closed, true);
  const result = await api.runProcess(process.execPath, ["-e", 'process.stderr.write("a".repeat(4096)+"THE-END");process.stdout.write("ok")']);
  assert.equal(result.stdout, "ok"); assert.equal(Buffer.byteLength(result.stderr), 32); assert.ok(result.stderr.endsWith("THE-END"));
});

test("bounded downloads work without content-length and remove only their partial file", async t => {
  const dir = await directory(t), filename = path.join(dir, "asset");
  const stream = () => new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(16)); controller.enqueue(new Uint8Array(16)); controller.close();
  } });
  await downloadToFile(new Response(stream()), filename, 32);
  assert.equal((await fs.stat(filename)).size, 32);
  await assert.rejects(downloadToFile(new Response(stream()), filename, 32), { code: "EEXIST" });
  assert.equal((await fs.stat(filename)).size, 32);
  await assert.rejects(downloadToFile(new Response(stream(), { headers: { "Content-Length": "999" } }), filename, 20), { statusCode: 413 });
  assert.equal((await fs.stat(filename)).size, 32);
  await assert.rejects(downloadToFile(new Response(stream()), filename + "-large", 20), { statusCode: 413 });
  await assert.rejects(fs.stat(filename + "-large"), { code: "ENOENT" });
  await assert.rejects(downloadToFile(new Response(stream(), { headers: { "Content-Length": "99" } }), filename + "-declared", 32), { statusCode: 413 });
  await assert.rejects(fs.stat(filename + "-declared"), { code: "ENOENT" });
});

test("every film decode entry rejects oversized sources while exact pixel boundary works", async t => {
  const sharp = require("sharp");
  const film = require("../apps/api/src/film-scan-utils.cjs");
  const dir = await directory(t), source = path.join(dir, "source.png");
  await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).png().toFile(source);
  t.after(() => film.configureFilmResources(resolveResourceProfile({})));
  film.configureFilmResources(resolveResourceProfile({ FILM_SCAN_MAX_PIXELS: "255" }));
  for (const fn of [() => film.inspectFilmScanSource(source), () => film.createAnalysisImage(source),
    () => film.sampleFilmBaseAtPoint(source, { x: 0.5, y: 0.5 }),
    () => film.renderFilmSourceContact(source, path.join(dir, "contact.jpg")),
    () => film.renderFilmFrame({ sourcePath: source }), () => film.renderFilmRawFrame({ sourcePath: source })]) {
    await assert.rejects(fn(), { statusCode: 413 });
  }
  film.configureFilmResources(resolveResourceProfile({ FILM_SCAN_MAX_PIXELS: "256" }));
  assert.equal((await film.createAnalysisImage(source)).width, 16);
});

test("asset proxy cancellation propagates to the upstream fetch before headers arrive", async () => {
  let upstreamSignal, requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const api = await fixture(["handleAsset", "httpError"], {
    URL, ASSET_PRESETS: new Set(), DIRECTUS_URL: "http://cms.invalid",
    directusLogin: async () => "fixture", sendJson() {},
    assetAccess: () => ({ media: false, article: false }),
    canReadAsset: async () => true, PUBLIC_ASSET_IDS: new Set(),
    fetchDirectusAsset: (...args) => new Promise((resolve, reject) => {
      upstreamSignal = args[5]; upstreamSignal.addEventListener("abort", () => reject(upstreamSignal.reason));
      requestStarted();
    })
  });
  const response = new EventEmitter();
  response.setHeader = () => {};
  const work = api.handleAsset({ method: "GET", headers: {} }, new URL("http://api.invalid/assets/abc"), response);
  await started; response.emit("close"); await work;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(response.listenerCount("close"), 0);
});

test("oversized existing film jobs fail before persisting crop, split or roll changes", async () => {
  let writes = 0;
  const api = await fixture(["handleFilmScanFramePatch", "handleFilmScanJobPatch"], {
    readJsonBody: async () => ({ action: "split", rotation: 90 }),
    directusLogin: async () => "fixture",
    getFilmScanFrameRecord: async () => ({ job: { status: "review_required" }, frame: { source_id: 1 } }),
    getFilmScanJobRecord: async () => ({ status: "review_required" }),
    listFilmScanSources: async () => [{ id: 1, relative_path: "existing.tiff" }],
    directusRelationId: value => value, filmScanSourcePath: value => value,
    inspectFilmScanSource: async () => { throw Object.assign(new Error("pixel limit"), { statusCode: 413 }); },
    directusRequest: async () => { writes++; }, updateFilmScanJob: async () => { writes++; }
  });
  await assert.rejects(api.handleFilmScanFramePatch({}, {}, 1, 1, 1), { statusCode: 413 });
  await assert.rejects(api.handleFilmScanJobPatch({}, {}, 1, 1), { statusCode: 413 });
  assert.equal(writes, 0);
});

test("low-resource IMF encoding bounds x265 pools without changing HDR metadata", () => {
  const { buildImfEncode } = require("../apps/api/src/imf.cjs");
  const { args } = buildImfEncode({ crop: { width: 160, height: 96, x: 0, y: 0 },
    mastering: { green: "13250,34500", blue: "7500,3000", red: "34000,16000", white: "15635,16450", max: 10000000, min: 50 },
    video: { path: "source.mxf", start: 0, seconds: 1 }, primaries: "smpte432", maxCLL: 1000, maxFALL: 400
  }, "output.mp4");
  const limited = mediaThreadArgs(args, 1);
  const original = args[args.indexOf("-x265-params") + 1].split(":");
  const updated = limited[limited.indexOf("-x265-params") + 1].split(":");
  assert.ok(updated.includes("pools=1")); assert.ok(updated.includes("frame-threads=1"));
  assert.deepEqual(updated.filter(v => !/^(pools|frame-threads)=/.test(v)), original.filter(v => !/^pools=/.test(v)));
  assert.equal(limited[limited.indexOf("-c:v") + 1], "libx265");
  assert.deepEqual(mediaThreadArgs(args, 0), args);
});
