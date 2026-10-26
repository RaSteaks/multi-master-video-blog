const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createTaskLimiter } = require("../src/task-limiter.cjs");
const source = fs.readFileSync(path.join(__dirname, "../src/server.cjs"), "utf8");

// Use production functions with isolated I/O, without starting the API or touching CMS data.
function fixture(names, dependencies, declarations = "") {
  const context = vm.createContext({ URLSearchParams, AbortSignal, ...dependencies });
  vm.runInContext(declarations + names.map(name => {
    const match = source.match(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^}", "m"));
    assert.ok(match, name);
    return match[0];
  }).join("\n"), context);
  return context;
}

// Incremental analytics, replay and recovery are covered in tests/security-remediation.test.cjs.

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
