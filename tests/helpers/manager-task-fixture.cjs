const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { html } = require("../../scripts/manager-dashboard.cjs");

async function startFixture(port = 0) {
  // Serve the real UI against synthetic state; never invoke Windows services.
  const fixture = { operation: null, offline: false };
  const services = [
    ["postgres", "PostgreSQL"], ["cms", "Directus CMS"], ["api", "Upload API"], ["web", "Frontend Web"]
  ].map(([id, name]) => ({ id, name, running: true, healthy: true,
    kind: id === "postgres" ? "windows-service" : "process", category: "Fixture",
    port: 3000, pids: [123], status: 200, mode: "development", modeLabel: "Development",
    serviceName: "postgres-fixture", healthUrl: "http://localhost/health", logName: id }));
  fixture.begin = label => (fixture.operation = { id: randomUUID(), label, state: "running",
    startedAt: new Date().toISOString(), steps: [] });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname.replace(/^\/manager/, "");
    if (!pathname || pathname === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8"); return res.end(html());
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (fixture.offline) { res.statusCode = 503; return res.end(JSON.stringify({ error: "Fixture disconnected" })); }
    let data;
    if (pathname === "/api/status") data = {
      updatedAt: new Date().toISOString(), services, database: { healthy: true }, uploadTokens: { path: "fixture", tokens: [] },
      manager: { host: "127.0.0.1", port, pid: 123, uptime: 1, node: process.version }, operation: fixture.operation
    };
    else if (pathname.startsWith("/api/operations/")) data = { ok: true, operation: fixture.operation };
    else if (pathname.startsWith("/api/logs/")) data = { serviceId: "web", stdout: "", stderr: "", files: {} };
    else if (req.method === "POST" && pathname.startsWith("/api/services/")) {
      const [, , , id, action] = pathname.split("/");
      res.statusCode = 202; data = { ok: true, operation: fixture.begin(id + ":" + action) };
    } else { res.statusCode = 404; data = { error: "Unknown fixture route" }; }
    res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  fixture.url = "http://127.0.0.1:" + server.address().port + "/manager";
  fixture.close = () => new Promise(resolve => server.close(resolve));
  return fixture;
}

if (require.main === module) startFixture(8093).then(fixture => {
  fixture.begin("web:restart");
  fixture.operation.steps = [{ serviceId: "web", phase: "start", state: "running" }];
  console.log(fixture.url);
});
module.exports = { startFixture };
