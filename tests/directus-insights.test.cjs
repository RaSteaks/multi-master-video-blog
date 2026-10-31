const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { buildSchema, graphql } = require("graphql");
const { repairInsightsAggregation } = require("../scripts/repair-directus-insights.cjs");
const exec = promisify(execFile);

const brokenPanel = {
  id: "video-chart", name: "Video projects", type: "line-chart", dashboard: "content-dashboard",
  options: {
    collection: "video_projects", xAxis: "created_at", yAxis: "id",
    filter: { published: { _eq: true } }, grouping: "category", color: "#42b883", showLegend: true
  }
};

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-insights-"));
  const panels = structuredClone(options.panels ?? [brokenPanel, {
    ...brokenPanel, id: "healthy-chart", options: { ...brokenPanel.options, aggregation: "sum" }
  }, { id: "video-list", name: "Videos", type: "list", options: { collection: "video_projects" } }]);
  const calls = [];
  // A real GraphQL schema rejects undefined functions/fields instead of emulating query validation.
  const schema = buildSchema(`
    type Query { video_projects_aggregated: [VideoAggregate!]! }
    type VideoAggregate { count: VideoCount, sum: VideoCount }
    type VideoCount { id: Int }
  `);
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url, "http://fixture");
    calls.push({ method: req.method, path: url.pathname, body });
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/auth/login") {
      return options.failLogin ? send(401, { errors: [{ message: "Invalid credentials" }] }) :
        send(200, { data: { access_token: "fixture-token" } });
    }
    if (req.headers.authorization !== "Bearer fixture-token") return send(401, { errors: [{ message: "Unauthorized" }] });
    if (url.pathname === "/graphql") {
      const result = await graphql({ schema, source: body.query,
        rootValue: { video_projects_aggregated: () => [{ count: { id: 2 }, sum: { id: 3 } }] } });
      return send(result.errors ? 400 : 200, result);
    }
    if (url.pathname === "/panels") return send(200, { data: panels });
    const panel = panels.find(item => item.id === decodeURIComponent(url.pathname.slice("/panels/".length)));
    if (!panel) return send(404, { errors: [{ message: "Panel not found" }] });
    if (req.method === "PATCH" && !options.ignorePatch) Object.assign(panel, body);
    send(200, { data: panel });
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    dir, panels, calls, backupDir: path.join(dir, "backups with spaces"),
    env: { DIRECTUS_URL: `http://127.0.0.1:${server.address().port}`, ADMIN_EMAIL: "fixture@example.invalid", ADMIN_PASSWORD: "fixture-password" }
  };
}

test("default inspection finds malformed line charts without changing panels or creating backups", async t => {
  const f = await fixture(t);
  const result = await repairInsightsAggregation(f);
  assert.equal(result.mode, "preview");
  assert.equal(result.updated, 0);
  assert.deepEqual(result.panels.map(panel => panel.id), ["video-chart"]);
  assert.equal(result.panels[0].currentAggregation, null);
  assert.deepEqual(f.panels[0], brokenPanel);
  assert.ok(!f.calls.some(call => call.method === "PATCH" || call.path === "/graphql"));
  await assert.rejects(fs.stat(f.backupDir), { code: "ENOENT" });
});

test("selected preview shows the proposed aggregation without writing", async t => {
  const f = await fixture(t);
  const result = await repairInsightsAggregation({ ...f, panelId: "video-chart", aggregation: "count" });
  assert.equal(result.panels[0].proposedAggregation, "count");
  assert.equal(result.updated, 0);
  assert.ok(!f.calls.some(call => call.path === "/panels" || call.method === "PATCH"));
  assert.deepEqual(f.panels[0], brokenPanel);
});

test("apply verifies GraphQL, backs up original options, preserves custom settings and is idempotent", async t => {
  const f = await fixture(t);
  const originalPanels = structuredClone(f.panels);
  const config = { ...f, panelId: "video-chart", aggregation: "count", apply: true };
  const result = await repairInsightsAggregation(config);
  assert.equal(result.updated, 1);
  assert.equal(result.graphqlVerified, true);
  assert.deepEqual(JSON.parse(await fs.readFile(result.backupPath, "utf8")), brokenPanel);
  assert.deepEqual(f.panels[0], { ...brokenPanel, options: { ...brokenPanel.options, aggregation: "count" } });
  assert.deepEqual(f.panels.slice(1), originalPanels.slice(1));
  const writes = f.calls.filter(call => call.method === "PATCH");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { options: { ...brokenPanel.options, aggregation: "count" } });
  assert.ok(f.calls.findIndex(call => call.path === "/graphql") < f.calls.indexOf(writes[0]));
  assert.equal(f.calls.at(-1).method, "GET", "saved options are read back after the patch");
  assert.equal((await repairInsightsAggregation(config)).updated, 0);
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 1);
  assert.equal((await fs.readdir(f.backupDir)).length, 1);
});

test("apply requires an explicit panel and supported function before contacting CMS", async () => {
  for (const config of [{ apply: true }, { apply: true, panelId: "video-chart" },
    { apply: true, aggregation: "count" }, { panelId: "video-chart", aggregation: "undefined" }]) {
    await assert.rejects(repairInsightsAggregation({ env: {}, ...config }), /requires|Unsupported/);
  }
});

test("valid saved aggregation is preserved even when another function is supplied", async t => {
  const f = await fixture(t);
  assert.equal((await repairInsightsAggregation({ ...f, panelId: "healthy-chart", aggregation: "count", apply: true })).updated, 0);
  assert.equal(f.panels[1].options.aggregation, "sum");
  assert.ok(!f.calls.some(call => call.method === "PATCH"));
});

test("GraphQL field errors prevent configuration writes and backups", async t => {
  const f = await fixture(t, { panels: [{ ...brokenPanel, options: { ...brokenPanel.options, yAxis: "missing_field" } }] });
  await assert.rejects(repairInsightsAggregation({ ...f, panelId: "video-chart", aggregation: "count", apply: true }), /Cannot query field/);
  assert.ok(!f.calls.some(call => call.method === "PATCH"));
  await assert.rejects(fs.stat(f.backupDir), { code: "ENOENT" });
});

test("non-chart panels and malformed API options are rejected without writes", async t => {
  const f = await fixture(t);
  await assert.rejects(repairInsightsAggregation({ ...f, panelId: "video-list", aggregation: "count", apply: true }), /targets line-chart/);
  f.panels[0].options = "invalid-json-object";
  await assert.rejects(repairInsightsAggregation({ ...f, panelId: "video-chart", aggregation: "count", apply: true }), /invalid panel configuration/);
  assert.ok(!f.calls.some(call => call.method === "PATCH"));
});

test("invalid GraphQL identifiers are rejected before query execution", async t => {
  const f = await fixture(t, { panels: [{ ...brokenPanel, options: { ...brokenPanel.options, yAxis: "id } } }" } }] });
  await assert.rejects(repairInsightsAggregation({ ...f, panelId: "video-chart", aggregation: "count", apply: true }), /valid collection and Y axis/);
  assert.ok(!f.calls.some(call => call.method === "PATCH" || call.path === "/graphql"));
});

test("failed persistence reports a failure and retains the original backup", async t => {
  const f = await fixture(t, { ignorePatch: true });
  await assert.rejects(repairInsightsAggregation({ ...f, panelId: "video-chart", aggregation: "count", apply: true }), /repair was not persisted/);
  const files = await fs.readdir(f.backupDir);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.backupDir, files[0]), "utf8")), brokenPanel);
});

test("authentication failures stop inspection without exposing credentials", async t => {
  const f = await fixture(t, { failLogin: true });
  await assert.rejects(repairInsightsAggregation(f), error => {
    assert.match(error.message, /401.*Invalid credentials/);
    assert.doesNotMatch(error.message, /fixture-password|fixture-token/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("CLI reads the deployment environment path and previews by default", async t => {
  const f = await fixture(t);
  const envPath = path.join(f.dir, "deployed cms.env");
  await fs.writeFile(envPath, Object.entries(f.env).map(([key, value]) => `${key}="${value}"`).join("\n"));
  const script = path.resolve(__dirname, "../scripts/repair-directus-insights.cjs");
  const { stdout } = await exec(process.execPath, [script, "--panel-id", "video-chart", "--aggregation", "count"], {
    cwd: f.dir, env: { PATH: process.env.PATH, DIRECTUS_ENV_PATH: envPath }
  });
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "preview");
  assert.equal(result.updated, 0);
  assert.equal(result.panels[0].proposedAggregation, "count");
  assert.doesNotMatch(stdout, /fixture-password|fixture-token/);
  assert.ok(!f.calls.some(call => call.method === "PATCH"));
});
