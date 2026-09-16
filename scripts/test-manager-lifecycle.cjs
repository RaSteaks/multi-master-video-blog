const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const sourcePath = path.join(__dirname, "manager-dashboard.cjs");
const source = fs.readFileSync(sourcePath, "utf8");
function harness(root = path.resolve(__dirname, ".."), env = {}) {
  const context = vm.createContext({ require: createRequire(sourcePath), module: { exports: {} }, __dirname: path.join(root, "scripts"),
    process: { env: { ...process.env, ...env }, pid: process.pid }, console, Buffer, URL, AbortSignal, fetch, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return { context, run: (code) => vm.runInContext(code, context) };
}

test("module import does not start an HTTP listener", () => {
  assert.equal(require("./manager-dashboard.cjs").server.listening, false);
});

test("rejects concurrent operations and releases lock after failure", async (t) => {
  const root = temporaryRoot(t);
  const { withOperation } = harness(root).context.module.exports;
  let unblock;
  const held = new Promise(resolve => { unblock = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const first = withOperation("test", async () => { entered(); await held; throw new Error("test failure"); });
  const rejected = assert.rejects(first, /test failure/);
  await ready;
  await assert.rejects(withOperation("overlap", async () => {}), e => e.statusCode === 409);
  const { run } = harness(root);
  await assert.rejects(run('withOperation("separate-instance", async () => {})'), e => e.statusCode === 409);
  unblock();
  await rejected;
  assert.equal(await withOperation("next", async () => 42), 42);
});

test("production rebuild stops before building; development skips build", async () => {
  const { run } = harness();
  run('var calls = []; stopProcessService = async () => calls.push("stop"); buildWeb = async () => calls.push("build"); startProcessService = async () => calls.push("start");');
  run('currentWebMode = "production"');
  await run('handleAction("web", "rebuild-restart")');
  assert.equal(run('calls.join(",")'), 'stop,build,start');
  run('calls = []; currentWebMode = "development"');
  await run('handleAction("web", "rebuild-restart")');
  assert.equal(run('calls.join(",")'), 'stop,start');
});

test("failed build never starts the web service", async () => {
  const { run } = harness();
  run('var started = false; currentWebMode = "production"; stopProcessService = async () => {}; buildWeb = async () => { throw new Error("build failed") }; startProcessService = async () => { started = true };');
  await assert.rejects(run('handleAction("web", "rebuild-restart")'), /build failed/);
  assert.equal(run('started'), false);
});

test("mode change persists only after health succeeds", async () => {
  const { run } = harness();
  run('var calls = []; currentWebMode = "development"; stopProcessService = async () => calls.push("stop"); buildWeb = async () => calls.push("build"); startProcessService = async () => calls.push("start:" + currentWebMode); setRootEnvValue = () => calls.push("persist");');
  await run('handleWebModeChange("production")');
  assert.equal(run('calls.join(",")'), 'stop,build,start:production,persist');
});

test("mode switch startup failure restores previous mode without saving", async () => {
  const { run } = harness();
  run('var calls = []; currentWebMode = "development"; stopProcessService = async () => calls.push("stop"); buildWeb = async () => {}; setRootEnvValue = () => { throw new Error("must not save") }; startProcessService = async () => { calls.push(currentWebMode); if (currentWebMode === "production") throw new Error("unhealthy") };');
  await assert.rejects(run('handleWebModeChange("production")'), /Previous mode restored/);
  assert.equal(run('currentWebMode'), 'development');
  assert.equal(run('calls.join(",")'), 'stop,production,stop,development');
});

test("occupied but unhealthy port is not startup success", async () => {
  const { run } = harness();
  run('getPortOwners = async () => [123]; waitForProcessHealth = async () => { throw new Error("unhealthy listener") };');
  await assert.rejects(run('startProcessService(serviceMap.get("api"))'), /unhealthy listener/);
});

test("startup stops at failed dependency; stop-all still attempts all services", async () => {
  const { run } = harness();
  run('var calls = []; handleAction = async (id) => { calls.push(id); if (id === "cms") throw new Error("failed"); return { message: "ok" } };');
  await assert.rejects(run('runStackActions(["postgres", "cms", "api", "web"], "start")'));
  assert.equal(run('calls.join(",")'), 'postgres,cms');
  run('calls = []');
  await assert.rejects(run('runStackActions(["web", "api", "cms", "postgres"], "stop")'));
  assert.equal(run('calls.join(",")'), 'web,api,cms,postgres');
});

test("HTTP health timeout aborts an unresponsive server", async () => {
  const http = require("node:http");
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { run } = harness();
    const result = await run('checkHttp("http://127.0.0.1:' + server.address().port + '", 50)');
    assert.equal(result.ok, false);
    assert.ok(result.elapsed < 2000);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("rendered browser script parses and uses persistent feedback", () => {
  const { html } = require("./manager-dashboard.cjs");
  const page = html();
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  assert.doesNotMatch(script, /\bconfirm\(/);
  assert.doesNotMatch(script, /reportValidity\(/);
});

test("restart-all recovers stopped services while preserving stop errors", async () => {
  const { run } = harness();
  run('var calls = []; delay = async () => {}; runStackActions = async (ids, action) => { calls.push(action); if (action === "stop") { const error = new Error("postgres access denied"); error.results = [{serviceId:"postgres",ok:false}]; throw error; } return {ok:true}; };');
  await assert.rejects(run('handleStackAction("restart-all")'), /Restart was incomplete.*Startup recovery completed/);
  assert.equal(run('calls.join(",")'), 'stop,start');
});

test("empty production build exit code is not success", async () => {
  const { run } = harness();
  run('runPowerShell = async () => "";');
  await assert.rejects(run('buildWeb()'), /Web build failed/);
});

function temporaryRoot(t) {
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manager-regression-"));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("persisted mode switch supersedes startup override and honors later file changes", async (t) => {
  const root = temporaryRoot(t);
  const { run } = harness(root, { MANAGER_WEB_MODE: "development" });
  run('stopProcessService = async () => {}; buildWeb = async () => {}; startProcessService = async () => {};');
  await run('withOperation("switch", () => handleWebModeChange("production"))');
  assert.equal(await run('withOperation("next", async () => currentWebMode)'), "production");
  fs.writeFileSync(path.join(root, ".env"), "MANAGER_WEB_MODE=development\n");
  assert.equal(await run('withOperation("external-switch", async () => currentWebMode)'), "development");
});

test("failed mode switch retains the startup override", async (t) => {
  const { run } = harness(temporaryRoot(t), { MANAGER_WEB_MODE: "development" });
  run('stopProcessService = async () => {}; startProcessService = async () => {}; buildWeb = async () => { throw new Error("build failed"); };');
  await assert.rejects(run('withOperation("switch", () => handleWebModeChange("production"))'), /build failed/);
  assert.equal(run('process.env.MANAGER_WEB_MODE'), "development");
  assert.equal(await run('withOperation("next", async () => currentWebMode)'), "development");
});

test("service startup releases the operation while the npm service stays running", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const root = temporaryRoot(t);
  const http = require("node:http");
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { serve: "node service.cjs" } }));
  fs.writeFileSync(path.join(root, "service.cjs"), `
    require('node:fs').writeFileSync('service.pid', String(process.pid));
    require('node:fs').writeSync(1, 'fixture started'); require('node:fs').writeSync(2, 'fixture stderr');
    const server = require('node:http').createServer((req,res)=>res.end('healthy'));
    server.listen(${port}, '127.0.0.1');
    setTimeout(()=>process.exit(0), 20000);
  `);
  const { run } = harness(root, { MANAGER_WAIT_MS: "5000" });
  run(`var fixture = {id:'fixture', name:'Fixture', port:${port}, healthUrl:'http://127.0.0.1:${port}', startArgs:['run','serve'], logName:'fixture'};`);
  try {
    const started = Date.now();
    await run('withOperation("start-all", () => startProcessService(fixture))');
    assert.ok(Date.now() - started < 10000, "startup must finish before the service exits");
    assert.equal(run('activeOperation'), null);
    assert.equal(await run('withOperation("next", async () => 42)'), 42);
    assert.equal((await run('checkHttp(fixture.healthUrl)')).ok, true);
    assert.match(fs.readFileSync(path.join(root, 'logs/fixture.out.log'), 'utf8'), /fixture started/);
    assert.match(fs.readFileSync(path.join(root, 'logs/fixture.err.log'), 'utf8'), /fixture stderr/);
  } finally {
    await run('stopProcessService(fixture)');
  }
});
