const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { html } = require("../scripts/manager-dashboard.cjs");

function taskHarness() {
  // Exercise the emitted browser functions with journal snapshots, never services.
  const script = html().match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = new Map();
  const context = vm.createContext({ document: { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, {});
    return nodes.get(id);
  } } });
  const functions = ["esc", "renderCurrentTasks", "renderOperation"].map(name =>
    script.match(new RegExp("    function " + name + "\\([\\s\\S]*?^    }", "m"))[0]);
  vm.runInContext(`
    let latestOperationStartedAt='', lastOperationSignature='', trackedOperationId=null;
    let trackedOperationStartedAt='', submittingOperation=false, refreshPromise=null, statusAvailable=true;
    let operationPollTimer=null; const finishedOperations=new Set();
    function setBusy() {} function setActionReadout() {} function scheduleOperationPoll() {}
    function clearTimeout() {} function refresh() {}
  ` + functions.join("\n"), context);
  return {
    nodes,
    render(operation) { context.operation = operation; vm.runInContext("renderOperation(operation)", context); },
    content() { return nodes.get("currentTasks").innerHTML; }
  };
}

function operation(label, state = "running", steps = []) {
  return { id: "task-1", label, state, steps, startedAt: "2026-10-22T00:00:00Z", message: "Result" };
}

test("current tasks name start, stop and restart for all four services before a phase begins", () => {
  for (const [id, name] of Object.entries({ postgres: "PostgreSQL", cms: "CMS", api: "API", web: "web" })) {
    for (const [action, verb] of Object.entries({ start: "启动", stop: "停止", restart: "重启" })) {
      const ui = taskHarness();
      ui.render(operation(id + ":" + action));
      assert.ok(ui.content().includes("当前正在" + verb + name));
      assert.match(ui.content(), /正在准备/);
    }
  }
});

test("batch commands show their actual active service and phase", () => {
  for (const [id, name] of Object.entries({ postgres: "PostgreSQL", cms: "CMS", api: "API", web: "web" })) {
    const ui = taskHarness();
    ui.render(operation("restart-all", "running", [
      { serviceId: "web", phase: "stop", state: "succeeded" },
      { serviceId: id, phase: "start", state: "running" }
    ]));
    assert.match(ui.content(), /当前正在重启全部服务/);
    assert.ok(ui.content().includes(name + " · 启动并检查健康状态"));
  }
  for (const label of ["start-all", "stop-all", "refresh-app", "upload-tokens", "web-mode:production", "web-mode:development", "web:rebuild-restart"]) {
    const ui = taskHarness();
    ui.render(operation(label));
    assert.doesNotMatch(ui.content(), /undefined|当前没有/);
  }
});

test("empty, restored, completed, failed and interrupted tasks stay distinct from stale snapshots", () => {
  for (const state of ["succeeded", "failed", "interrupted"]) {
    const ui = taskHarness();
    ui.render(null);
    assert.match(ui.content(), /当前没有正在执行的任务/);
    ui.render(operation("web:restart"));
    ui.render(null); // Late empty response must not hide an accepted command.
    assert.match(ui.content(), /当前正在重启web/);
    ui.render(operation("web:restart", state));
    assert.match(ui.content(), /当前没有正在执行的任务/);
    assert.equal(ui.nodes.get("operationPanel").hidden, false);
    ui.render(operation("web:restart"));
    assert.match(ui.content(), /当前没有正在执行的任务/);
  }
});

test("task phase content is escaped before rendering", () => {
  const ui = taskHarness();
  ui.render(operation("restart-all", "running", [{ serviceId: "<img src=x>", phase: "<script>", state: "running" }]));
  assert.doesNotMatch(ui.content(), /<img|<script/);
  assert.match(ui.content(), /&lt;img/);
});
