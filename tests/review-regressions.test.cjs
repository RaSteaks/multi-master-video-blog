const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { AsyncLocalStorage } = require("node:async_hooks");
const { promisify } = require("node:util");
const exec = promisify(require("node:child_process").execFile);
const { createTaskLimiter } = require("../apps/api/src/task-limiter.cjs");
const { resolveResourceProfile } = require("../config/resource-profile.cjs");
const film = require("../apps/api/src/film-scan-utils.cjs");
const root = path.resolve(__dirname, "..");

function functions(source, names) {
  return names.map(name => {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name); return match[0];
  }).join("\n");
}
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-review-fix-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function filmFixture(t) {
  const dir = await temporary(t), original = path.join(dir, "1/original.png");
  await fs.mkdir(path.dirname(original));
  await require("sharp")({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toFile(original);
  film.configureFilmResources(resolveResourceProfile({ RESOURCE_PROFILE: "low-2gb", FILM_SCAN_MAX_PIXELS: "1" }));
  t.after(() => film.configureFilmResources(resolveResourceProfile({})));
  const state = { status: "uploaded", deleted: [], failPersist: false };
  const sources = [{ id: 10, relative_path: "film-scans/1/original.png" }];
  const source = await fs.readFile(path.join(root, "apps/api/src/server.cjs"), "utf8");
  const api = vm.createContext({ path, fsp: fs, URLSearchParams, setImmediate,
    console: { error() {} }, resourceLimits: { enabled: true }, maintenanceMode: false,
    mediaProcessingSlots: createTaskLimiter(), mediaContext: new AsyncLocalStorage(),
    filmScanQueue: ["1"], activeFilmScanJobId: null, filmScanJobControllers: new Map(),
    FILM_SCAN_ROOT: dir, MEDIA_ROOT: dir, FILM_SCAN_JOB_FIELDS: "*",
    filmScanPath: require("../apps/api/src/media-security.cjs").filmScanPath,
    registerFilmScanController: () => new AbortController(), releaseFilmScanController() {},
    withFilmScanTimeout: (operation, label, controller) => operation(controller.signal),
    throwIfFilmScanAborted: signal => { if (signal?.aborted) throw signal.reason; },
    directusLogin: async () => "fixture", assertInside() {},
    directusRequest: async (url, token, options) => {
      if (options?.method === "DELETE") state.deleted.push(url);
      if (url.startsWith("/items/film_scan_jobs?")) {
        const statuses = new URLSearchParams(url.split("?")[1]).get("filter[status][_in]").split(",");
        return { data: statuses.includes(state.status) ? [{ id: 1, status: state.status }] : [] };
      }
      return { data: { id: 1, status: state.status } };
    },
    updateFilmScanJob: async (token, id, patch) => {
      if (state.failPersist) throw new Error("CMS unavailable");
      Object.assign(state, patch);
    },
    listFilmScanSources: async () => sources, listFilmScanFrames: async () => [],
    inspectFilmScanSource: film.inspectFilmScanSource,
    cleanupFilmScanPartialCommit: async () => {},
    getFilmScanJobRecord: async () => ({ id: 1, status: state.status }),
    sendJson() {}, httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode })
  });
  vm.runInContext("let filmScanPreviewTail = Promise.resolve();\n" + functions(source, [
    "drainFilmScanQueue", "analyzeFilmScanJob", "recoverFilmScanQueue", "enqueueFilmScanJob",
    "filmScanSourcePath", "filmScanJobDirectory", "enqueueFilmScanPreview", "cleanupFilmScanJobAssets",
    "cleanupFilmScanJobAssetsNow", "handleFilmScanCancel"
  ]), api);
  const restart = async () => {
    await api.recoverFilmScanQueue();
    const deadline = Date.now() + 3000;
    while (api.activeFilmScanJobId !== null || api.filmScanQueue.length) {
      assert.ok(Date.now() < deadline, "recovery must settle rather than busy-loop");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  return { api, state, original, restart };
}

test("resource-blocked original survives failures and repeated restarts, then resumes with a larger budget", async t => {
  const { api, state, original, restart } = await filmFixture(t);
  const bytes = await fs.readFile(original);
  await api.drainFilmScanQueue();
  assert.equal(state.status, "resource_blocked");
  assert.match(state.error_message, /像素限制/);
  assert.deepEqual(state.deleted, []);
  await restart(); await restart();
  assert.equal(state.status, "resource_blocked");
  assert.deepEqual(await fs.readFile(original), bytes);
  assert.deepEqual(state.deleted, []);
  film.configureFilmResources(resolveResourceProfile({ FILM_SCAN_MAX_PIXELS: "4" }));
  let resumed = 0;
  // Isolate downstream image rendering; exercise recovery and the real input guard.
  api.analyzeFilmScanJob = async () => { await film.inspectFilmScanSource(original); state.status = "review_required"; resumed++; };
  await restart();
  assert.equal(resumed, 1); assert.equal(state.status, "review_required");
  assert.deepEqual(await fs.readFile(original), bytes);
});

test("resource rejection preserves originals even when its CMS status write fails", async t => {
  const { api, state, original } = await filmFixture(t);
  state.failPersist = true;
  await api.drainFilmScanQueue();
  await fs.access(original);
  assert.equal(state.status, "uploaded"); assert.deepEqual(state.deleted, []);
  assert.equal(api.mediaProcessingSlots.snapshot().active, 0);
});

test("ordinary decode failures and explicit cancellation still clean up their originals", async t => {
  const { api, state, original } = await filmFixture(t);
  api.inspectFilmScanSource = async () => { throw new Error("decoder failed"); };
  await api.drainFilmScanQueue();
  assert.equal(state.status, "failed");
  await assert.rejects(fs.access(original), { code: "ENOENT" });
  assert.ok(state.deleted.includes("/items/film_scan_sources/10"));
  // Cancellation is an explicit user action, including for previously blocked work.
  await fs.mkdir(path.dirname(original)); await fs.writeFile(original, "fixture");
  state.status = "resource_blocked";
  await api.handleFilmScanCancel({}, 1, 1);
  assert.equal(state.status, "canceled");
  await assert.rejects(fs.access(original), { code: "ENOENT" });
});

test("maintenance blocks while an article is uploading or cleaning up, even after its socket closes", async () => {
  const source = await fs.readFile(path.join(root, "apps/api/src/server.cjs"), "utf8");
  let finishUpload, finishCleanup, cleanupStarted = false;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const slots = createTaskLimiter(), responses = [];
  const api = vm.createContext({ URL, HOST: "127.0.0.1", PORT: 8060,
    activeWriteRequests: 0, maintenanceMode: false,
    requireUploadAuth() {}, requireArticleAuth() {}, readJsonBody: async () => ({ enabled: true }),
    drainFilmScanQueue() {}, sendJson: (res, status, body) => { responses.push({ status, body }); res.emit("close"); },
    parseArticleMultipart: () => new Promise(resolve => { finishUpload = resolve; }),
    normalizeArticleUpload: () => { throw new Error("fixture validation error"); },
    fsp: { rm: async () => { cleanupStarted = true; await cleanup; } }
  });
  vm.runInContext(functions(source, ["dispatchRequest", "handleRequest", "handleArticleCreate"]), api);
  const request = (url, method = "POST") => ({ url, method, headers: { host: "fixture.invalid" } });
  const response = new EventEmitter();
  const work = api.dispatchRequest(request("/articles"), response);
  assert.equal(api.activeWriteRequests, 1);
  const maintenance = await fs.readFile(path.join(root, "scripts/maintenance.cjs"), "utf8");
  const checker = vm.createContext({ action: "drain", endpoint: "http://fixture.invalid", env: {}, AbortSignal,
    console: { log() {} }, fetch: async url => {
      if (url.endsWith("/maintenance")) await api.dispatchRequest(request("/maintenance"), new EventEmitter());
      return { ok: true, json: async () => ({ resources: { activeWrites: api.activeWriteRequests,
        queue: slots.snapshot(), videoQueue: slots.snapshot(), filmControllers: 0 } }) };
    }
  });
  vm.runInContext(functions(maintenance, ["main"]), checker);
  await assert.rejects(checker.main(), /still active/);
  assert.equal(api.maintenanceMode, true);
  await api.dispatchRequest(request("/articles"), new EventEmitter());
  assert.equal(responses.at(-1).status, 503);
  assert.equal(api.activeWriteRequests, 1);
  response.emit("close");
  assert.equal(api.activeWriteRequests, 1);
  finishUpload({ tempDir: "fixture" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanupStarted, true); assert.equal(api.activeWriteRequests, 1);
  checker.action = "check";
  await assert.rejects(checker.main(), /still active/);
  finishCleanup(); await work;
  assert.equal(api.activeWriteRequests, 0);
  await checker.main();
});

test("maintenance fails closed against APIs without write-drain counters", async () => {
  const source = await fs.readFile(path.join(root, "scripts/maintenance.cjs"), "utf8");
  const api = vm.createContext({ action: "check", endpoint: "http://fixture.invalid", AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ resources: {} }) }) });
  vm.runInContext(functions(source, ["main"]), api);
  await assert.rejects(api.main(), /write-drain tracking/);
});

test("native update build forwards shared and web overrides to the actual launcher", async t => {
  const dir = await temporary(t);
  for (const sub of ["scripts", "config", "apps/web", "node_modules/next/dist/bin"]) await fs.mkdir(path.join(dir, sub), { recursive: true });
  for (const filename of ["scripts/run-service.cjs", "config/resource-profile.cjs"]) await fs.copyFile(path.join(root, filename), path.join(dir, filename));
  const shared = path.join(dir, "resources.env"), web = path.join(dir, "web.env");
  await fs.writeFile(shared, "RESOURCE_PROFILE=low-2gb\nBUILD_HEAP_MIB=512\nBUILD_WORKERS=1\n");
  await fs.writeFile(web, "BUILD_HEAP_MIB=640\nBUILD_WORKERS=2\nAPI_INTERNAL_URL=http://api.fixture:9000\n");
  // A local Next CLI stand-in captures the child budget/environment without building the app.
  await fs.writeFile(path.join(dir, "node_modules/next/dist/bin/next.js"), `console.log(JSON.stringify({argv:process.execArgv,workers:process.env.BUILD_WORKERS,url:process.env.API_INTERNAL_URL,profile:process.env.RESOURCE_PROFILE}));`);
  const script = await fs.readFile(path.join(root, "deployment/linux/update-native.sh"), "utf8");
  const command = script.split("\n").find(line => line.includes('cd "$release"') && line.endsWith("scripts/run-service.cjs build)"));
  assert.ok(command);
  const args = command.split("/usr/bin/node ")[1].slice(0, -1).split(" ")
    .map(arg => arg.replace("/etc/video-blog/resources.env", shared).replace("/etc/video-blog/web.env", web));
  const { stdout } = await exec(process.execPath, args, { cwd: dir,
    env: { PATH: process.env.PATH, CMS_RUNTIME_ONLY: "true" } });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.argv, ["--max-old-space-size=640"]);
  assert.equal(result.workers, "2"); assert.equal(result.url, "http://api.fixture:9000"); assert.equal(result.profile, "low-2gb");
});

test("schema upgrade adds the blocked choice once without replacing custom options", async () => {
  const source = await fs.readFile(path.join(root, "scripts/setup-directus-schema.cjs"), "utf8");
  let options = { allowOther: true, choices: [{ text: "Custom", value: "custom" }] }, writes = 0;
  const api = vm.createContext({ request: async (url, init) => {
    if (init.method === "PATCH") { options = init.body.meta.options; writes++; return {}; }
    return { data: { meta: { options } } };
  } });
  vm.runInContext(functions(source, ["ensureFilmResourceBlockedStatus"]), api);
  await api.ensureFilmResourceBlockedStatus("fixture"); await api.ensureFilmResourceBlockedStatus("fixture");
  assert.equal(writes, 1); assert.equal(options.allowOther, true);
  assert.equal(options.choices[0].value, "custom"); assert.equal(options.choices[1].value, "resource_blocked");
});
