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

test("production rebuild stops before building; development rejects misleading build action", async () => {
  const { run } = harness();
  run('var calls = []; stopProcessService = async () => calls.push("stop"); buildWeb = async () => calls.push("build"); startProcessService = async () => calls.push("start");');
  run('currentWebMode = "production"');
  await run('handleAction("web", "rebuild-restart")');
  assert.equal(run('calls.join(",")'), 'stop,build,start');
  run('calls = []; currentWebMode = "development"');
  await assert.rejects(run('handleAction("web", "rebuild-restart")'), /Production mode/);
  assert.equal(run('calls.join(",")'), '');
});

test("ordinary production restart reuses a build and missing build gives an actionable error", async t => {
  const { run } = harness(temporaryRoot(t));
  run('currentWebMode="production"; var calls=[]; stopProcessService=async()=>calls.push("stop"); startProcessService=async()=>calls.push("start"); buildWeb=async()=>{throw new Error("must not build")};');
  await run('handleAction("web","restart")');
  assert.equal(run('calls.join(",")'), 'stop,start');
  const second = harness(temporaryRoot(t));
  second.run('currentWebMode="production"; getPortOwners=async()=>[]; buildWeb=async()=>{throw new Error("must not build")};');
  await assert.rejects(second.run('startProcessService(serviceMap.get("web"))'), /No production Web build.*Build \+ Restart/);
});

test("update application touches only API and Web, and stops after API failure", async () => {
  const { run } = harness();
  run('currentWebMode="production"; var calls=[]; handleAction=async(id,action)=>{calls.push(id+":"+action);return {message:"ok"}};');
  await run('handleStackAction("refresh-app")');
  assert.equal(run('calls.join(",")'), 'api:restart,web:rebuild-restart');
  run('calls=[]; currentWebMode="development";');
  await run('handleStackAction("refresh-app")');
  assert.equal(run('calls.join(",")'), 'api:restart,web:restart');
  run('calls=[]; handleAction=async(id)=>{calls.push(id);throw new Error("API failed")};');
  await assert.rejects(run('handleStackAction("refresh-app")'), error => error.results.length === 1);
  assert.equal(run('calls.join(",")'), 'api');
});

test("accepted operations expose progress and survive an independent observer", async t => {
  const root=temporaryRoot(t), { run, context }=harness(root);
  let release;
  context.blocked=new Promise(resolve=>{release=resolve});
  const accepted=await run('beginManagedOperation("api:restart",()=>serviceStep(serviceMap.get("api"),"start",async()=>{await blocked; return {message:"healthy"}}))');
  assert.equal(accepted.state,"running");
  const observer=harness(root);
  const running=await observer.run('operationJournal.read()');
  assert.equal(running.id,accepted.id);
  assert.equal(running.state,"running");
  await assert.rejects(observer.run('beginManagedOperation("overlap",async()=>{})'), error=>error.statusCode===409);
  release();
  // Poll the durable outcome, not arbitrary sleep-based execution assumptions.
  let outcome;
  for(let attempt=0;attempt<100;attempt++) {
    outcome=await observer.run('operationJournal.read()');
    if(outcome.state!=="running") break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(outcome.state,"succeeded");
  assert.equal(outcome.steps[0].state,"succeeded");
});

test("failed operations keep step outcomes without storing secret result fields", async t => {
  const root=temporaryRoot(t), {run}=harness(root);
  await assert.rejects(run('withOperation("test",()=>serviceStep(serviceMap.get("api"),"start",async()=>{throw new Error("unhealthy")}))'),/unhealthy/);
  let result=await run('operationJournal.read()');
  assert.equal(result.state,"failed"); assert.equal(result.steps[0].state,"failed");
  await run('withOperation("test",async()=>({message:"done",token:"secret-value"}))');
  result=await run('operationJournal.read()');
  assert.doesNotMatch(JSON.stringify(result),/secret-value/);
  fs.writeFileSync(path.join(root,"logs/service-operation.json"),JSON.stringify({...result,state:"running"}));
  assert.equal((await run('operationJournal.read()')).state,"interrupted");
});

test("HTTP accepts a service operation before completion and exposes its final failure", async t => {
  const {run,context}=harness(temporaryRoot(t), { MANAGER_AUTH_PASSWORD: "fixture-only" });
  // The fixture isolates HTTP dispatch from authentication tests and real OS services.
  run('isAuthenticated=()=>true; requireManagerMutation=()=>{};');
  let unblock;context.gate=new Promise(resolve=>{unblock=resolve});
  run('handleAction=async()=>{await gate; throw new Error("fixture startup failed")};');
  const server=context.module.exports.server;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/api/services/api/restart',{method:'POST'});
  assert.equal(response.status,202);
  const {operation}=await response.json();
  const overlap=await fetch(base+'/api/services/web/start',{method:'POST'});
  assert.equal(overlap.status,409);
  assert.equal((await fetch(base+'/api/services/api/invalid',{method:'POST'})).status,400);
  assert.equal((await fetch(base+'/api/services/unknown/start',{method:'POST'})).status,404);
  unblock();
  let final;
  for(let n=0;n<100;n++){
    final=(await (await fetch(base+'/api/operations/'+operation.id)).json()).operation;
    if(final.state!=='running')break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(final.state,'failed'); assert.match(final.message,/fixture startup failed/);
});

test("all four service aliases and stack aliases use the shared controller", () => {
  const scripts=require('../package.json').scripts;
  for(const id of ['postgres','cms','api','web']) for(const action of ['start','stop','restart','status','health']) {
    assert.equal(scripts[id+':'+action],`node scripts/service-control.cjs ${id} ${action}`);
  }
  assert.equal(scripts['services:update'],'node scripts/service-control.cjs stack refresh-app');
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

function browserOperationHarness() {
  // Run the functions emitted to the browser with controlled responses/timing;
  // no real service, DOM implementation or wall-clock polling is involved.
  const script = require('./manager-dashboard.cjs').html().match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const context = vm.createContext({
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); } },
    AbortSignal, clearTimeout() {}, fetch() { throw new Error('Unexpected request'); }
  });
  vm.runInContext(`
    let busy=false, submittingOperation=false, trackedOperationId=null, trackedOperationStartedAt="";
    let operationPollTimer=null, operationPollFailures=0, operationPollInFlight=false;
    let lastOperationSignature="", latestOperationStartedAt="", statusAvailable=true, refreshPromise=null;
    let readout="", refreshes=0; const finishedOperations=new Set(), MUTATION_HEADERS={};
    const esc=String, apiPath=value=>value;
    function setBusy(value){busy=value;}
    function setActionReadout(value){readout=value;}
    function scheduleOperationPoll(){}
    async function refresh(){refreshes++;statusAvailable=true;}
  ` + ['managerFetch','renderCurrentTasks','renderOperation','submitOperation','pollOperation'].map(name => {
    const match=script.match(new RegExp('    (?:async )?function '+name+'\\([\\s\\S]*?^    }','m'));
    assert.ok(match,name);return match[0];
  }).join('\n'),context);
  return {context,run:code=>vm.runInContext(code,context),render(operation){context.incoming=operation;vm.runInContext('renderOperation(incoming)',context);}};
}
const browserOperation = (id,state,second=0) => ({id,label:'api:restart',state,startedAt:`2026-01-01T00:00:0${second}.000Z`,steps:[],message:id+' '+state});

test("a newer terminal operation unlocks a missed completion without accepting stale results", () => {
  for(const terminal of ['succeeded','failed','interrupted']) {
    const ui=browserOperationHarness();
    ui.render(browserOperation('A','running'));
    ui.render(browserOperation('B',terminal,2));
    assert.equal(ui.run('busy'),false);
    assert.equal(ui.run('trackedOperationId'),null);
    assert.equal(ui.run('refreshes'),1);
    ui.render(browserOperation('A','succeeded'));
    ui.render(browserOperation('A','running'));
    assert.equal(ui.run('busy'),false);
    assert.equal(ui.run('readout'),'B '+terminal);
  }
});

test("old completion cannot unlock a newer running command, even with equal timestamps", () => {
  for(const second of [0,2]) {
    const ui=browserOperationHarness();
    ui.render(browserOperation('A','running'));
    ui.render(browserOperation('B','running',second));
    ui.render(browserOperation('A','succeeded'));
    assert.equal(ui.run('busy'),true);assert.equal(ui.run('trackedOperationId'),'B');
    ui.render(browserOperation('B','succeeded',second));
    assert.equal(ui.run('busy'),false);
  }
});

test("late POST acknowledgement cannot replace an operation already observed by polling", async () => {
  const ui=browserOperationHarness();let respond;
  ui.context.fetch=()=>new Promise(resolve=>{respond=resolve;});
  const pending=ui.run('submitOperation("/api/services/api/restart","Restart API")');
  ui.render(browserOperation('A','running'));
  ui.render(browserOperation('B','running',2));
  respond({ok:true,json:async()=>({ok:true,operation:browserOperation('A','running')})});
  await pending;
  assert.equal(ui.run('trackedOperationId'),'B');assert.equal(ui.run('busy'),true);
  ui.render(browserOperation('B','succeeded',2));
  assert.equal(ui.run('busy'),false);
});

test("terminal result seen during POST admission is reconciled on the next status refresh", async () => {
  const ui=browserOperationHarness();let respond;
  ui.context.fetch=()=>new Promise(resolve=>{respond=resolve;});
  const pending=ui.run('submitOperation("/api/services/api/restart","Restart API")');
  ui.render(browserOperation('A','running'));
  ui.render(browserOperation('B','succeeded',2));
  assert.equal(ui.run('busy'),true,'Do not unlock while POST acceptance is still pending');
  respond({ok:true,json:async()=>({ok:true,operation:browserOperation('A','running')})});
  await pending;
  ui.render(browserOperation('B','succeeded',2));
  assert.equal(ui.run('busy'),false);assert.equal(ui.run('trackedOperationId'),null);
});

test("failure from an expired poll cannot overwrite the newer completed result", async () => {
  const ui=browserOperationHarness();let reject;
  ui.context.fetch=()=>new Promise((_resolve,fail)=>{reject=fail;});
  ui.render(browserOperation('A','running'));
  const pending=ui.run('pollOperation()');
  ui.render(browserOperation('B','succeeded',2));
  reject(new Error('Old request timed out'));await pending;
  assert.equal(ui.run('readout'),'B succeeded');assert.equal(ui.run('operationPollFailures'),0);
  assert.equal(ui.run('busy'),false);
});

test("restart-all recovers stopped services while preserving stop errors", async () => {
  const { run } = harness();
  run('var calls = []; delay = async () => {}; runStackActions = async (ids, action) => { calls.push(action); if (action === "stop") { const error = new Error("postgres access denied"); error.results = [{serviceId:"postgres",ok:false}]; throw error; } return {ok:true}; };');
  await assert.rejects(run('handleStackAction("restart-all")'), /Restart was incomplete.*Startup recovery completed/);
  assert.equal(run('calls.join(",")'), 'stop,start');
});

test("empty production build exit code is not success", async t => {
  const { run } = harness(temporaryRoot(t));
  run('runPowerShell = async () => "";');
  await assert.rejects(run('buildWeb()'), /Web build failed/);
});

test("failed build invalidates the old build marker and zero exit still requires a fresh marker", async t => {
  const root=temporaryRoot(t),{run}=harness(root);
  const buildId=path.join(root,'apps/web/.next/BUILD_ID');
  fs.mkdirSync(path.dirname(buildId),{recursive:true});fs.writeFileSync(buildId,'old');
  run('runPowerShell=async()=>"1";');
  await assert.rejects(run('buildWeb()'),/exit code 1/);
  assert.equal(fs.existsSync(buildId),false);
  run('runPowerShell=async()=>"0";');
  await assert.rejects(run('buildWeb()'),/no valid BUILD_ID/);
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
