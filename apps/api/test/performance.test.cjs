const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createTaskLimiter } = require("../src/task-limiter.cjs");
const source = fs.readFileSync(path.join(__dirname, "../src/server.cjs"), "utf8");

// Use production functions with isolated I/O, without starting the API or touching CMS data.
function fixture(names, dependencies, declarations = "") {
  const context = vm.createContext({ URLSearchParams, ...dependencies });
  vm.runInContext(declarations + names.map(name => {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  }).join("\n"), context);
  return context;
}

test("analytics preserves counts and last-event time using bounded aggregate results", async () => {
  let payload;
  let groups = [
    { event_type: "view", count: { id: "12000" }, countDistinct: { visitor_hash: "400" }, max: { created_at: "2026-10-15T01:00:00Z" } },
    { event_type: "play", count: { id: "500" }, countDistinct: { visitor_hash: "80" }, max: { created_at: "2026-10-15T02:00:00Z" } }
  ];
  const api = fixture(["syncAnalyticsItem"], {
    directusRequest: async (url, token, options) => {
      if (url.startsWith("/items/analytics_events?")) {
        const query = new URLSearchParams(url.split("?")[1]);
        assert.equal(query.get("aggregate[count]"), "id");
        assert.equal(query.get("aggregate[countDistinct]"), "visitor_hash");
        assert.equal(query.get("aggregate[max]"), "created_at");
        assert.equal(query.get("groupBy[]"), "event_type");
        assert.equal(query.get("filter[item_key][_eq]"), "video:7");
        return { data: groups };
      }
      if (!options) return { data: [{ id: 1 }] };
      payload = options.body;
      return { data: payload };
    }
  });
  const refresh = () => api.syncAnalyticsItem("token", { itemType: "video", itemId: 7 }, { id: 7, title: "Test", slug: "test" });
  await refresh();
  assert.deepEqual([payload.view_count, payload.visitor_count, payload.play_count, payload.player_count], [12000, 400, 500, 80]);
  assert.equal(payload.last_event_at, "2026-10-15T02:00:00Z");
  groups = [];
  await refresh();
  assert.equal(payload.view_count, 0);
  assert.equal(payload.last_event_at, null);
});

test("analytics merges bursts and serializes a trailing refresh for events received during a write", async () => {
  let release, entered, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const api = fixture(["scheduleAnalyticsRefresh"], {
    setTimeout: callback => { queueMicrotask(callback); },
    syncAnalyticsItem: async () => { if (++calls === 1) { entered(); await gate; } }
  }, "const analyticsRefreshes = new Map();\n");
  const schedule = () => api.scheduleAnalyticsRefresh("token", { itemType: "post", itemId: 1 }, {});
  const firstBurst = Array.from({ length: 20 }, schedule);
  await ready;
  const secondBurst = Array.from({ length: 20 }, schedule);
  assert.equal(calls, 1);
  release();
  await Promise.all([...firstBurst, ...secondBurst]);
  assert.equal(calls, 2);
  await schedule();
  assert.equal(calls, 3);
});

test("video slots bound concurrency, reject excess/expired waiters, and release once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slots = createTaskLimiter({ concurrency: 1, maxPending: 1, waitMs: 100 });
  const release = await slots.acquire();
  const waiting = slots.acquire();
  await assert.rejects(slots.acquire(), { statusCode: 503 });
  release(); release();
  const releaseSecond = await waiting;
  const expired = assert.rejects(slots.acquire(), { statusCode: 503 });
  t.mock.timers.tick(101);
  await expired;
  releaseSecond();
  (await slots.acquire())();
});

test("ordinary media processes inherit a deadline and are killed on timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let killed = false;
  child.kill = signal => { assert.equal(signal, "SIGKILL"); killed = true; queueMicrotask(() => child.emit("close", null)); };
  const api = fixture(["runProcess", "httpError"], {
    spawn: () => child, path, Buffer, REPO_ROOT: os.tmpdir(), VIDEO_PROCESS_TIMEOUT_MS: 100,
    mediaContext: { getStore: () => null }, FFPROBE_PATH: "ffprobe",
    mediaThreadArgs: require("../src/resource-io.cjs").mediaThreadArgs,
    resourceLimits: require("../../../config/resource-profile.cjs").resolveResourceProfile({}),
    setTimeout, clearTimeout
  });
  const timedOut = assert.rejects(api.runProcess("ffmpeg", []), { statusCode: 504 });
  t.mock.timers.tick(101);
  await timedOut;
  assert.equal(killed, true);
});

test("file-backed multipart content survives an authentication retry", async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-blob-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "image.bin");
  const bytes = Buffer.alloc(1024 * 1024, 73);
  await fsp.writeFile(filename, bytes);
  let attempts = 0;
  const api = fixture(["directusUploadFile"], {
    fs, FormData, DIRECTUS_URL: "http://fixture.invalid",
    refreshDirectusLogin: async () => "fresh-token",
    fetch: async (url, options) => {
      const file = options.body.get("file");
      assert.equal(file.name, "image.bin");
      assert.equal(file.type, "image/jpeg");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      if (++attempts === 1) return { status: 401, arrayBuffer: async () => new ArrayBuffer(0) };
      assert.equal(options.headers.Authorization, "Bearer fresh-token");
      return { status: 200, ok: true, text: async () => '{"data":{"id":"file-id"}}' };
    }
  });
  assert.equal(await api.directusUploadFile("expired", { tempPath: filename, filename: "image.bin", mimeType: "image/jpeg" }, "Test"), "file-id");
  assert.equal(attempts, 2);
});
