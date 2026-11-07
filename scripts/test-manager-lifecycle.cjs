const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const sourcePath = path.join(__dirname, "manager-dashboard.cjs");
const source = fs.readFileSync(sourcePath, "utf8");
function harness(root = path.resolve(__dirname, ".."), env = {}, platform = "win32", execFile, modules = {}) {
  const requireModule = createRequire(sourcePath);
  // execFile alone, or a { execFile, spawn } stand-in for the whole module.
  const childProcess = typeof execFile === "function" ? { execFile } : execFile;
  const context = vm.createContext({ require: id => id === "node:child_process" && childProcess ? childProcess : modules[id] ?? requireModule(id), module: { exports: {} }, __dirname: path.join(root, "scripts"),
    process: { env: { ...process.env, ...env }, pid: process.pid, execPath: process.execPath, platform }, console, Buffer, URL, AbortSignal, fetch, setTimeout, clearTimeout });
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

test("update stops API/Web before installing, builds only in production, then starts in dependency order", async () => {
  const { run } = harness();
  run('currentWebMode="production"; var calls=[]; handleAction=async(id,action)=>{calls.push(id+":"+action);return {message:"ok"}}; installAppDependencies=async()=>calls.push("install"); buildWeb=async()=>calls.push("build");');
  await run('handleStackAction("refresh-app")');
  assert.equal(run('calls.join(",")'), 'web:stop,api:stop,install,build,api:start,web:start');
  run('calls=[]; currentWebMode="development";');
  await run('handleStackAction("refresh-app")');
  assert.equal(run('calls.join(",")'), 'web:stop,api:stop,install,api:start,web:start');
});

test("application update records every completed step and never advances past a failure", async t => {
  const expected = ['web:stop', 'api:stop', 'app-dependencies:install', 'web:build', 'api:start', 'web:start'];
  for (const failure of expected) {
    const { run, context } = harness(temporaryRoot(t), { MANAGER_WEB_MODE: "production" });
    context.failure = failure;
    run('currentWebMode="production"; var calls=[]; var invoke=async(key)=>{calls.push(key);if(key===failure)throw new Error("fixture failure");return {message:"ok"}}; stopProcessService=async(s)=>invoke(s.id+":stop"); startProcessService=async(s)=>invoke(s.id+":start"); installAppDependencies=async()=>invoke("app-dependencies:install"); buildWeb=async()=>invoke("web:build");');
    await assert.rejects(run('withOperation("refresh-app",()=>handleStackAction("refresh-app"))'), error => {
      assert.equal(error.results.length, expected.indexOf(failure) + 1);
      assert.equal(error.results.at(-1).ok, false);
      return /fixture failure/.test(error.message);
    });
    assert.equal(run('calls.join(",")'), expected.slice(0, expected.indexOf(failure) + 1).join(','));
    const journal = await run('operationJournal.read()');
    assert.equal(journal.state, 'failed');
    assert.equal(journal.steps.at(-1).state, 'failed');
    assert.equal(journal.steps.at(-1).serviceId + ':' + journal.steps.at(-1).phase, failure);
  }
});

test("dependency install waits for scoped npm with build tools, logs output, and propagates failures", async t => {
  const root = temporaryRoot(t);
  const { run } = harness(root);
  run('var command; runPowerShell=async(value)=>{command=value;return "0"};');
  await run('installAppDependencies()');
  const command = run('command');
  assert.match(command, /-FilePath 'npm\.cmd'/);
  assert.match(command, /'install','--workspace=@multi-master-video-blog\/api','--workspace=@multi-master-video-blog\/web'/);
  assert.match(command, /'--include-workspace-root=false','--include=dev','--no-audit','--no-fund'/);
  assert.match(command, /-Wait -PassThru/);
  assert.ok(command.includes(root));
  assert.match(command, /app\.dependencies\.out\.log/);
  assert.match(command, /app\.dependencies\.err\.log/);
  assert.doesNotMatch(command, /'ci'|--ignore-scripts|--workspace=.*cms/);
  fs.writeFileSync(path.join(root, 'logs/app.dependencies.err.log'), 'fixture install failure');
  assert.equal((await run('readServiceLogs("app-dependencies")')).stderr, 'fixture install failure');
  for (const result of ['1', '']) {
    run(`runPowerShell=async()=>${JSON.stringify(result)}`);
    await assert.rejects(run('installAppDependencies()'), /API and Web remain stopped.*app.dependencies.err.log/);
  }
});

test("update installs newly declared workspace dependencies with real npm and retains CMS/root packages", { skip: !process.env.npm_execpath }, async t => {
  const root = temporaryRoot(t);
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  const writePackage = (directory, data) => {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, 'package.json'), JSON.stringify(data));
  };
  for (const name of ['runtime-fixture', 'build-fixture', 'cms-fixture', 'manager-fixture']) {
    writePackage('packages/' + name, { name, version: '1.0.0', main: 'index.cjs' });
    fs.writeFileSync(path.join(root, 'packages', name, 'index.cjs'), `module.exports=${JSON.stringify(name)};`);
  }
  writePackage('.', { private: true, workspaces: ['apps/*'], dependencies: { 'manager-fixture': 'file:packages/manager-fixture' } });
  for (const id of ['api', 'web', 'cms']) writePackage('apps/' + id, { name: '@multi-master-video-blog/' + id, version: '1.0.0',
    ...(id === 'cms' ? { dependencies: { 'cms-fixture': 'file:../../packages/cms-fixture' } } : {}) });
  const npm = args => execFile(process.execPath, [process.env.npm_execpath, ...args, '--offline', '--cache', path.join(root, 'npm-cache')],
    { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, timeout: 30000 });
  await npm(['install', '--no-audit', '--no-fund']);
  for (const id of ['api', 'web']) writePackage('apps/' + id, { name: '@multi-master-video-blog/' + id, version: '1.0.0',
    dependencies: { 'runtime-fixture': 'file:../../packages/runtime-fixture' },
    ...(id === 'web' ? { devDependencies: { 'build-fixture': 'file:../../packages/build-fixture' } } : {}) });
  const { run, context } = harness(root);
  // Translate only the Windows launch boundary; execute the actual generated npm
  // arguments against local fixtures, with no registry or installed-service access.
  context.runPowerShell = async command => {
    const args = [...command.match(/-ArgumentList @\((.*?)\) -WorkingDirectory/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    await npm(args);
    return '0';
  };
  await run('installAppDependencies()');
  for (const id of ['api', 'web']) {
    const localRequire = createRequire(path.join(root, 'apps', id, 'package.json'));
    assert.equal(localRequire('runtime-fixture'), 'runtime-fixture');
    if (id === 'web') assert.equal(localRequire('build-fixture'), 'build-fixture');
  }
  assert.equal(createRequire(path.join(root, 'apps/cms/package.json'))('cms-fixture'), 'cms-fixture');
  assert.equal(createRequire(path.join(root, 'package.json'))('manager-fixture'), 'manager-fixture');
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
  return {context,run:code=>vm.runInContext(code,context),summary:()=>nodes.get('operationSummary')?.textContent,render(operation){context.incoming=operation;vm.runInContext('renderOperation(incoming)',context);}};
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
    // The operation panel keeps the accepted result; the readout does not repeat it.
    assert.match(ui.summary(),new RegExp(' · B '+terminal+'$'));
    assert.equal(ui.run('readout'),'');
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
  assert.equal(ui.summary(),'Completed · B succeeded');assert.equal(ui.run('readout'),'');assert.equal(ui.run('operationPollFailures'),0);
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

test("Linux reports unit state separately from application health and controls only mapped units", async t => {
  const calls = [];
  let state = "active";
  const execFile = (file, args, options, callback) => {
    calls.push([file, ...args]);
    callback(null, { stdout: `LoadState=loaded\nActiveState=${state}\nSubState=running\nMainPID=42\n` });
  };
  const { run } = harness(temporaryRoot(t), {}, "linux", execFile);
  run('checkHttp = async () => ({ok:false,status:500}); waitForProcessHealth = async () => {};');
  const web = await run('getServiceStatus(serviceMap.get("web"), {})');
  assert.equal(web.running, true);
  assert.equal(web.healthy, false);
  assert.equal(web.status, 500);
  assert.equal(web.pids[0], 42);
  state = "failed";
  assert.equal((await run('getServiceStatus(serviceMap.get("cms"), {})')).unitState, "failed");
  for (const [id, unit] of Object.entries({ postgres: "postgresql@17-main", cms: "video-blog-cms", api: "video-blog-api", web: "video-blog-web" })) {
    for (const action of ["start", "stop", "restart"]) {
      await run(`handleAction("${id}", "${action}")`);
      assert.deepEqual(calls.at(-1), ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", action, unit + ".service"]);
    }
  }
  await assert.rejects(run('handleStackAction("refresh-app")'), /deployment workflow/);
});

test("Linux Web mode switch uses the active unit's build, persists both directions and recovers failures", async t => {
  const root = temporaryRoot(t);
  const modeFile = path.join(root, "web-mode");
  fs.writeFileSync(modeFile, "development\n");
  const mode = () => fs.readFileSync(modeFile, "utf8").trim();
  let webCommand = "/usr/bin/node scripts/run-service.cjs managed-web";
  let buildDirectory = root;
  let swap = 2 * 1024 ** 2;
  let failing = "";
  let priorState = "active";
  const actions = [];
  const execFile = (file, args, options, callback) => {
    const unit = args.at(-1);
    if (args[0] === "show") {
      const building = unit === "video-blog-web-build.service";
      const command = building ? "/usr/bin/node scripts/run-service.cjs build" : webCommand;
      return callback(null, { stdout: "LoadState=loaded\nActiveState=" + priorState + "\nSubState=running\nUser=admin\nWorkingDirectory=" +
        (building ? buildDirectory : root) + "\nExecStart={ path=/usr/bin/node ; argv[]=" + command + " ; ignore_errors=no }\n" });
    }
    if (args.includes("-l")) return callback(null, { stdout: "" });
    const action = unit === "video-blog-web-build.service" ? "build" : args.at(-2) + ":" + mode();
    actions.push(action);
    callback(action === failing ? Error(action + " failed") : null, { stdout: "" });
  };
  const { run } = harness(root, {}, "linux", execFile, {
    "./systemd-web-mode.cjs": { ...require("./systemd-web-mode.cjs"), MODE_FILE: modeFile },
    "node:fs/promises": { ...fs.promises, readFile: (file, ...args) => file === "/proc/meminfo"
      ? Promise.resolve("MemTotal: 2000000 kB\nSwapTotal: " + swap + " kB\n") : fs.promises.readFile(file, ...args) }
  });
  run('waitForProcessHealth = async () => {}; checkHttp = async () => ({ok:true,status:200});');
  const change = value => run(`withOperation("web-mode:${value}", () => handleWebModeChange("${value}"))`);
  const status = () => run('getServiceStatus(serviceMap.get("web"), {})');
  assert.equal((await status()).modeSwitchAvailable, true);
  await change("production");
  assert.deepEqual(actions.splice(0), ["stop:development", "build", "start:production"]);
  assert.equal((await status()).mode, "production");
  await change("production");
  assert.deepEqual(actions, []);
  await change("development");
  assert.deepEqual(actions.splice(0), ["stop:production", "start:development"]);
  for (failing of ["build", "start:production"]) {
    await assert.rejects(change("production"), /Web restarted in its previous mode/);
    assert.equal(mode(), "development");
    assert.equal(actions.splice(0).at(-1), "start:development");
    assert.equal((await run("operationJournal.read()")).state, "failed");
  }
  priorState = "inactive";
  failing = "build";
  await assert.rejects(change("production"), /Web is stopped/);
  assert.deepEqual(actions.splice(0), ["stop:development", "build", "stop:development"]);
  priorState = "active";
  swap = 0;
  await assert.rejects(change("production"), /swap/);
  buildDirectory = root + "/wrong-release";
  await assert.rejects(change("production"), /WorkingDirectory/);
  webCommand = "/usr/bin/npm run dev:web";
  assert.equal((await status()).mode, "development");
  assert.equal((await status()).modeSwitchAvailable, false);
  await assert.rejects(change("production"), /Enable Linux Web mode/);
  assert.deepEqual(actions, [], "preflight failures must keep the old Web serving");
});

test("Linux Pull updates only running checkout units and builds Web for its actual mode", async t => {
  const root = temporaryRoot(t);
  fs.mkdirSync(path.join(root, "apps/api"), { recursive: true });
  const release = temporaryRoot(t);
  const calls = [];
  let failBuild = false, failSchema = false;
  for (const file of require("./manager-repo.cjs").SCHEMA_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", file), path.join(root, file));
  }
  const cmsEnv = path.join(root, "cms.env");
  fs.writeFileSync(cmsEnv, 'ADMIN_EMAIL="fixture@example.invalid"\nADMIN_PASSWORD="fixture-secret"\nDIRECTUS_URL=http://127.0.0.1:18055\n');
  const execFile = (file, args, options, callback) => {
    const action = file === process.execPath ? "schema" : file === "npm" ? "install" : args.at(-2) + ":" + args.at(-1);
    if (action === "schema") {
      assert.equal(args.at(-1), "--upgrade-only");
      assert.equal(options.env.ADMIN_PASSWORD, "fixture-secret");
      assert.equal(options.env.DIRECTUS_URL, "http://127.0.0.1:18055");
      assert.equal(args.includes("fixture-secret"), false);
    }
    calls.push(action);
    callback(failSchema && action === "schema" ? Object.assign(Error("schema failed"), { stderr: "fixture migration error" })
      : failBuild && action === "start:video-blog-web-build.service" ? Error("build failed") : null, { stdout: "" });
  };
  const { run } = harness(root, { CMS_ENV_FILE: cmsEnv }, "linux", execFile);
  run(`var calls = []; var impact = {}, cwd = ROOT, mode = "dev:web", active = "active", upToDate = false;
    process.getuid = () => 1000;
    readUnit = async name => ({ LoadState:"loaded", ActiveState:name === "video-blog-cms.service" ? "active" : active, User:"admin", ExecStart:"npm run "+mode,
      WorkingDirectory:name === "video-blog-api.service" && cwd === ROOT ? ROOT+"/apps/api" : cwd });
    waitForProcessHealth = async () => {}; checkWebBuildUnit = async () => { calls.push("preflight") };
    repoUpdater.prepare = async () => ({impact, upToDate, message:"Already current", to:"b".repeat(40)});
    repoUpdater.fastForward = async () => { calls.push("pull"); return {message:"pulled"} };`);
  await run("readSchemaUpdate().then(state => saveSchemaUpdate(state.signature, null))");
  const pull = async impact => run(`impact=${JSON.stringify(impact)}; handleRepoPull()`);
  await pull({ api:true });
  assert.deepEqual(calls.splice(0), ["stop:video-blog-api.service", "start:video-blog-api.service"]);
  await pull({ web:true });
  assert.deepEqual(calls.splice(0), ["stop:video-blog-web.service", "start:video-blog-web.service"]);
  run('mode="start:web"; calls=[]');
  await pull({ cms:true, web:true, dependencies:true });
  assert.equal(run('calls.join(",")'), "preflight,pull");
  assert.deepEqual(calls.splice(0), ["stop:video-blog-web.service", "stop:video-blog-cms.service", "install",
    "start:video-blog-cms.service", "start:video-blog-web-build.service", "start:video-blog-web.service"]);
  run('active="inactive"');
  await pull({ api:true });
  assert.deepEqual(calls, []);
  run(`active="active"; cwd=${JSON.stringify(release)}`);
  assert.match((await pull({ api:true })).message, /update-native/);
  assert.deepEqual(calls, []);
  run('cwd=ROOT');
  run('mode="start:web"; active="active"; calls=[]');
  fs.appendFileSync(path.join(root, "shared/project-layouts.cjs"), "\n// fixture schema revision\n");
  failSchema = true;
  await assert.rejects(pull({ schema:true }), /schema upgrade failed.*retry Pull/);
  assert.deepEqual(calls.splice(0), ["stop:video-blog-web.service", "stop:video-blog-api.service", "schema"]);
  const failed = await run('readSchemaUpdate()');
  assert.equal(failed.needed, true);
  assert.deepEqual(Array.from(failed.pending.running), ["api", "web"]);
  assert.equal((await run('readServiceLogs("schema")')).stderr, "fixture migration error");
  failSchema = false;
  run('active="inactive"; upToDate=true; calls=[]');
  await pull({});
  assert.deepEqual(calls.splice(0), ["stop:video-blog-web.service", "stop:video-blog-api.service", "schema",
    "start:video-blog-api.service", "start:video-blog-web-build.service", "start:video-blog-web.service"]);
  assert.equal(run('calls.includes("pull")'), false, "Retry after fast-forward does not need another commit");
  const finished = await run('readSchemaUpdate()');
  assert.equal(finished.needed, false);
  assert.equal(finished.pending, null);
  await pull({});
  assert.deepEqual(calls, [], "An unchanged, completed schema is not applied again");
  run('active="active"; upToDate=false; calls=[]');
  failBuild = true;
  await assert.rejects(pull({ web:true }), /pulled.*build failed.*web/);
  assert.deepEqual(calls.splice(0), ["stop:video-blog-web.service", "start:video-blog-web-build.service"]);
  run('checkWebBuildUnit = async () => { throw Error("missing build unit") }; calls=[]');
  await assert.rejects(pull({ web:true }), /missing build unit/);
  assert.equal(run('calls.length'), 0, "preflight failed before Git or service changes");
  run('repoUpdater.fastForward = async () => { throw Error("checkout failed") }');
  await assert.rejects(pull({ api:true }), /checkout failed/);
  assert.deepEqual(calls, []);
});

test("Windows pull + update verifies before stopping, updates only after both stop, then installs and starts", async () => {
  const { run } = harness();
  const target = "b".repeat(40);
  run('currentWebMode="production"; var calls=[]; handleAction=async(id,action)=>{calls.push(id+":"+action);return {message:"ok"}}; installAppDependencies=async()=>calls.push("install"); buildWeb=async()=>calls.push("build");'
    + 'repoUpdater.prepare=async target=>{calls.push("verify:"+target);return {upToDate:false,count:2,from:"a".repeat(40),to:target,impact:{manager:true,api:true,cms:true}}};'
    + 'repoUpdater.fastForward=async plan=>{calls.push("pull:"+plan.to);return {message:"pulled"}};');
  const result = await run(`handleStackAction("pull-update", { target: "${target}" })`);
  assert.equal(run('calls.join(",")'), `verify:${target},web:stop,api:stop,pull:${target},install,build,api:start,web:start`);
  assert.match(result.message, /^Pulled 2 commits to bbbbbbb and updated API \+ Web\. Restart Directus CMS.*Restart Manager/);
  assert.doesNotMatch(result.message, /Run Update API \+ Web/);

  // A refused verification and an empty update both fail while the site still serves.
  run('calls=[]; repoUpdater.prepare=async()=>{calls.push("verify");throw Object.assign(new Error("Local changes to x would be overwritten"),{statusCode:409})};');
  await assert.rejects(run(`handleStackAction("pull-update", { target: "${target}" })`), error => /would be overwritten/.test(error.message) && error.results.length === 1);
  run('repoUpdater.prepare=async()=>({upToDate:true,message:"main already contains bbbbbbb."});');
  await assert.rejects(run(`handleStackAction("pull-update", { target: "${target}" })`), /Nothing to pull; use Update API \+ Web/);
  assert.equal(run('calls.join(",")'), 'verify');

  // A failed checkout update leaves API and Web stopped instead of starting a partial tree.
  run('calls=[]; repoUpdater.prepare=async target=>({upToDate:false,count:1,from:"a".repeat(40),to:target,impact:{}}); repoUpdater.fastForward=async()=>{calls.push("pull");throw new Error("unable to unlink")};');
  await assert.rejects(run(`handleStackAction("pull-update", { target: "${target}" })`), /unable to unlink/);
  assert.equal(run('calls.join(",")'), 'web:stop,api:stop,pull');
});

test("HTTP pull endpoints accept only the reviewed full commit ID", async t => {
  const { run } = harness(temporaryRoot(t), { MANAGER_AUTH_PASSWORD: "fixture-only" });
  run('isAuthenticated=()=>true; requireManagerMutation=()=>{}; var pulled=[]; handleRepoPull=async target=>{pulled.push("repo:"+target);return {message:"ok"}}; handleStackAction=async(action,options)=>{pulled.push(action+":"+options.target);return {message:"ok"}};');
  const server = run('module.exports.server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const settle = async response => {
    const { operation } = await response.json();
    for (let attempt = 0; attempt < 100; attempt++) {
      const latest = (await (await fetch(base + '/api/operations/' + operation.id)).json()).operation;
      if (latest.state !== 'running') return latest;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  for (const body of [{}, { target: 'main' }, { target: '--upload-pack=touch /tmp/x' }, { target: 'a'.repeat(39) }]) {
    assert.equal((await post('/api/repo/pull', body)).status, 400);
    assert.equal((await post('/api/stack/pull-update', body)).status, 400);
  }
  const target = 'c'.repeat(40);
  let response = await post('/api/repo/pull', { target });
  assert.equal(response.status, 202);
  assert.equal((await settle(response)).state, 'succeeded');
  response = await post('/api/stack/pull-update', { target });
  assert.equal(response.status, 202);
  await settle(response);
  assert.equal(run('pulled.join(",")'), `repo:${target},pull-update:${target}`);
});

test("Manager restart refuses during work, for foreground processes and when the code on disk cannot load", async t => {
  const root = temporaryRoot(t);
  fs.mkdirSync(path.join(root, 'deployment/windows'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deployment/windows/manager-service.ps1'), '');
  let loadError = null;
  const spawned = [];
  const childProcess = {
    execFile: (file, args, options, callback) => loadError
      ? callback(Object.assign(new Error('exit 1'), { stderr: loadError }), '', loadError)
      : callback(null, { stdout: '' }),
    spawn: (file, args, options) => { spawned.push({ file, args, options }); return {
      once(event, listener) { if (event === "spawn") setImmediate(listener); }, unref() {}
    }; }
  };
  const foreground = harness(root, {}, 'darwin', childProcess);
  await assert.rejects(foreground.run('requestManagerRestart()'), error => error.statusCode === 400 && /terminal that started it/.test(error.message));

  const { run } = harness(root, {}, 'win32', childProcess);
  run('activeOperation = "web:restart"');
  await assert.rejects(run('requestManagerRestart()'), error => error.statusCode === 409);
  run('activeOperation = null');
  loadError = "scripts/manager-dashboard.cjs:12\nSyntaxError: Unexpected token '}'";
  await assert.rejects(run('requestManagerRestart()'), error => error.statusCode === 409 && /does not load.*\n[\s\S]*SyntaxError/.test(error.message));
  assert.equal(run('managerRestart'), null);
  assert.equal(spawned.length, 0);

  loadError = null;
  const restart = await run('requestManagerRestart()');
  assert.equal(restart.state, 'pending');
  const operationPath = path.join(root, "logs", "service-operation");
  await assert.rejects(require("proper-lockfile").lock(operationPath, { realpath: false }), { code: "ELOCKED" });
  await assert.rejects(run('withOperation("web:start", async () => {})'), error => error.statusCode === 409 && /restarting/.test(error.message));
  run('launchManagerRestart()');
  assert.equal(spawned[0].file, 'powershell.exe');
  assert.deepEqual([...spawned[0].args], ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'deployment/windows/manager-service.ps1'), 'restart', '-Port', run('String(PORT)')]);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.windowsHide, true);
  assert.ok(fs.existsSync(path.join(root, 'logs/manager.restart.log')));
});

test("Linux restart requires owning the unit and the exact sudoers grant, then queues a non-blocking restart", async t => {
  const calls = [];
  let mainPid = 1;
  let sudoAllowed = true;
  const execFile = (file, args, options, callback) => {
    calls.push([file, ...args]);
    if (file === '/usr/bin/sudo' && args[1] === '-l' && !sudoAllowed) return callback(Object.assign(new Error('not allowed'), { code: 1 }));
    callback(null, { stdout: `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=${mainPid}\nNRestarts=2\n` });
  };
  const { run } = harness(temporaryRoot(t), {}, 'linux', execFile);
  await assert.rejects(run('requestManagerRestart()'), error => error.statusCode === 400 && /Cannot confirm this Manager belongs to video-blog-manager\.service/.test(error.message));
  mainPid = process.pid;
  sudoAllowed = false;
  await assert.rejects(run('requestManagerRestart()'), error => error.statusCode === 403 && /manager\.sudoers/.test(error.message));
  assert.equal(run('managerRestart'), null);
  sudoAllowed = true;
  assert.equal((await run('requestManagerRestart()')).state, 'pending');
  const command = ['/usr/bin/systemctl', '--no-block', 'restart', 'video-blog-manager.service'];
  assert.deepEqual(calls.at(-1), ['/usr/bin/sudo', '-n', '-l', ...command]);
  run('launchManagerRestart()');
  assert.deepEqual(calls.at(-1), ['/usr/bin/sudo', '-n', ...command]);
  const supervisor = await run('managerSupervisor()');
  assert.equal(supervisor.canRestart, true);
  assert.equal(supervisor.restarts, 2);

  // A unit without log redirection reports through the journal instead.
  const logs = await run('readServiceLogs("manager")');
  assert.deepEqual(calls.at(-1).slice(0, 3), ['/usr/bin/journalctl', '--unit', 'video-blog-manager.service']);
  assert.equal(logs.files.stdout, 'journalctl -u video-blog-manager.service');
  for (const id of ['cms', 'api', 'web']) {
    const unitLogs = await run(`readServiceLogs("${id}")`);
    assert.deepEqual(calls.at(-1).slice(0, 3), ['/usr/bin/journalctl', '--unit', `video-blog-${id}.service`]);
    assert.equal(unitLogs.serviceId, id);
  }
});

test("Linux restart recognizes a wrapped Manager only inside its systemd unit", async t => {
  const group = "/system.slice/video-blog-manager.service";
  let membership = "";
  const execFile = (file, args, options, callback) => {
    const unit = file === "/usr/bin/systemctl";
    if (unit) assert.ok(args[1].split(",").includes("ControlGroup"));
    callback(null, { stdout: unit ? `LoadState=loaded\nActiveState=active\nMainPID=1\nControlGroup=${group}\n` : "" });
  };
  const { run } = harness(temporaryRoot(t), {}, "linux", execFile, {
    "node:fs/promises": { ...fs.promises, readFile: async (file, encoding) => {
      if (file !== "/proc/self/cgroup") return fs.promises.readFile(file, encoding);
      if (membership === null) throw new Error("procfs unavailable");
      return membership;
    } }
  });
  for (membership of [null, "0::/user.slice/session.scope", "0::" + group + "-other", "1:cpu:" + group]) {
    await assert.rejects(run("requestManagerRestart()"), error => error.statusCode === 400);
  }
  membership = "4:cpu:/other\n1:name=systemd:" + group;
  assert.equal((await run("managerSupervisor()")).canRestart, true);
  membership = "0::" + group + "/workers";
  assert.equal((await run("requestManagerRestart()")).state, "pending");
  run("launchManagerRestart()");
});

test("restart excludes a CLI operation throughout preflight and unlocks on rejection", async t => {
  const root = temporaryRoot(t), operationPath = path.join(root, "logs", "service-operation");
  const manager = harness(root);
  let enter, resume;
  manager.context.started = new Promise(resolve => { enter = resolve; });
  manager.context.enter = enter;
  manager.context.preflight = new Promise(resolve => { resume = resolve; });
  manager.run('verifyManagerRestart = async () => { enter(); await preflight; throw new Error("rejected"); }');
  const restart = manager.run("requestManagerRestart()");
  await manager.context.started;
  const lockfile = require("proper-lockfile");
  await assert.rejects(lockfile.lock(operationPath, { realpath: false }), { code: "ELOCKED" });
  resume();
  await assert.rejects(restart, /rejected/);
  const release = await lockfile.lock(operationPath, { realpath: false });
  try { await assert.rejects(manager.run("requestManagerRestart()"), { statusCode: 409 }); }
  finally { await release(); }
});

test("restart polling restores controls at the deadline when every status request fails", async () => {
  const script = require("./manager-dashboard.cjs").html().match(/<script>([\s\S]*?)<\/script>/)[1];
  const watcher = script.match(/    async function watchManagerRestart\(pending\) \{[\s\S]*?\n    \}/)[0];
  const messages = [], busy = [];
  const context = vm.createContext({ managerRestartPending: { pid: 1, startedAt: Date.now() - 91000 },
    setTimeout: callback => callback(), fetch: async () => { throw new Error("offline"); },
    apiPath: value => value, AbortSignal, setSyncState() {}, setBusy: value => busy.push(value),
    setActionReadout: text => messages.push(text), scheduleLogPoll() {}, logPollIntervalMs: 1000 });
  await vm.runInContext(watcher + "\nwatchManagerRestart(managerRestartPending)", context);
  assert.equal(context.managerRestartPending, null);
  assert.deepEqual(busy, [false]);
  assert.match(messages[0], /not confirmed after 90 s/);
});

test("Manager reports its own code that changed on disk since it loaded", async t => {
  const root = temporaryRoot(t);
  const file = path.join(root, 'scripts/manager-extra.cjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'module.exports = 1;\n');
  const { run, context } = harness(root);
  context.require.cache = { [file]: {}, [path.join(root, 'node_modules/pkg/index.js')]: {}, [path.join(path.dirname(root), 'outside.cjs')]: {} };
  run('snapshotLoadedCode()');
  assert.equal(run('[...loadedCode.keys()].join(",")'), 'scripts/manager-extra.cjs');
  assert.equal(await run('loadedCodeChanges().then(JSON.stringify)'), '[]');
  fs.writeFileSync(file, 'module.exports = 22;\n');
  assert.equal(await run('loadedCodeChanges().then(JSON.stringify)'), '["scripts/manager-extra.cjs"]');
  fs.writeFileSync(file, 'module.exports = 1;\n');
  assert.equal(await run('loadedCodeChanges().then(JSON.stringify)'), '[]');
});
