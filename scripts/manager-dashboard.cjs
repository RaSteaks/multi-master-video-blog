const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const {
  loadDirectusEnv,
  openDirectusDatabase
} = require("./directus-db-utils.cjs");

const ROOT = path.resolve(__dirname, "..");
const HOST = process.env.MANAGER_HOST || "127.0.0.1";
const PORT = Number(process.env.MANAGER_PORT || 8070);
const WAIT_MS = Number(process.env.MANAGER_WAIT_MS || 30000);

const services = {
  web: {
    id: "web",
    name: "Frontend Web",
    port: 3000,
    url: "http://127.0.0.1:3000/",
    startArgs: ["run", "dev:web"],
    buildArgs: ["run", "build:web"],
    logName: "web"
  },
  cms: {
    id: "cms",
    name: "Directus CMS",
    port: 8055,
    url: "http://127.0.0.1:8055/server/health",
    startArgs: ["run", "start:cms"],
    logName: "cms"
  },
  api: {
    id: "api",
    name: "Upload API",
    port: 8060,
    url: "http://127.0.0.1:8060/health",
    startArgs: ["run", "start:api"],
    logName: "api"
  }
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendHtml(res) {
  const body = html();
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { cwd: ROOT, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function getPortOwners(port) {
  const command = [
    `$items = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue;`,
    "$items | Where-Object { $_.State -eq 'Listen' -and $_.OwningProcess } |",
    "Select-Object -ExpandProperty OwningProcess -Unique"
  ].join(" ");
  const stdout = await runPowerShell(command);
  return stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function stopService(service) {
  const owners = await getPortOwners(service.port);
  if (owners.length === 0) {
    return { ok: true, message: `${service.name} is already stopped.` };
  }

  const ownerList = owners.join(",");
  await runPowerShell(`Stop-Process -Id ${ownerList} -Force`);
  return { ok: true, message: `Stopped ${service.name}.`, pids: owners };
}

async function startService(service) {
  const owners = await getPortOwners(service.port);
  if (owners.length > 0) {
    return { ok: true, message: `${service.name} is already running.`, pids: owners };
  }

  const logDir = path.join(ROOT, "logs");
  await fsp.mkdir(logDir, { recursive: true });
  const stdout = fs.openSync(path.join(logDir, `${service.logName}.out.log`), "a");
  const stderr = fs.openSync(path.join(logDir, `${service.logName}.err.log`), "a");

  const child = spawn("npm.cmd", service.startArgs, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true
  });
  child.unref();

  await waitForService(service);
  return { ok: true, message: `Started ${service.name}.`, pid: child.pid };
}

async function buildWeb() {
  const web = services.web;
  const logDir = path.join(ROOT, "logs");
  await fsp.mkdir(logDir, { recursive: true });
  const stdout = fs.openSync(path.join(logDir, `${web.logName}.build.out.log`), "a");
  const stderr = fs.openSync(path.join(logDir, `${web.logName}.build.err.log`), "a");

  await new Promise((resolve, reject) => {
    const child = spawn("npm.cmd", web.buildArgs, {
      cwd: ROOT,
      stdio: ["ignore", stdout, stderr],
      windowsHide: true
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Web build failed with exit code ${code}. Check logs/web.build.err.log.`));
    });
  });
}

async function waitForService(service) {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started < WAIT_MS) {
    const status = await checkHttp(service.url);
    if (status.ok) return status;
    lastError = status.error || `HTTP ${status.status}`;
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  throw new Error(`${service.name} did not become healthy. Last error: ${lastError}`);
}

async function checkHttp(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { cache: "no-store" });
    return {
      ok: response.ok,
      status: response.status,
      elapsed: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      elapsed: Date.now() - started
    };
  }
}

async function getServiceStatus(service) {
  const [owners, httpStatus] = await Promise.all([
    getPortOwners(service.port),
    checkHttp(service.url)
  ]);

  return {
    id: service.id,
    name: service.name,
    port: service.port,
    url: service.url,
    running: owners.length > 0,
    pids: owners,
    healthy: httpStatus.ok,
    status: httpStatus.status || null,
    error: httpStatus.error || null,
    elapsed: httpStatus.elapsed
  };
}

async function getDatabaseStatus() {
  let db = null;

  try {
    db = await openDirectusDatabase(loadDirectusEnv());
    const tables = await db.listTables();
    const projects = await countTableRows(db, "video_projects", tables);
    const masters = await countTableRows(db, "video_masters", tables);

    return {
      id: "database",
      name: db.name,
      healthy: true,
      running: true,
      path: db.path,
      tables: tables.length,
      projects,
      masters
    };
  } catch (error) {
    return {
      id: "database",
      name: "Directus Database",
      healthy: false,
      running: false,
      path: "apps/cms/directus/.env",
      error: error.message
    };
  } finally {
    if (db) {
      await db.close().catch(() => {});
    }
  }
}

async function countTableRows(db, table, tables) {
  if (!tables.includes(table)) {
    return "N/A";
  }

  const row = await db.get(`select count(*) as count from ${db.tableRef(table)}`);
  return Number(row.count);
}

async function allStatus() {
  const serviceStatuses = await Promise.all(
    Object.values(services).map((service) => getServiceStatus(service))
  );
  const database = await getDatabaseStatus();
  return {
    updatedAt: new Date().toISOString(),
    services: serviceStatuses,
    database
  };
}

async function handleAction(serviceId, action) {
  const service = services[serviceId];
  if (!service) {
    const error = new Error(`Unknown service: ${serviceId}`);
    error.statusCode = 404;
    throw error;
  }

  if (action === "start") return startService(service);
  if (action === "stop") return stopService(service);
  if (action === "restart") {
    await stopService(service);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return startService(service);
  }
  if (action === "rebuild-restart" && serviceId === "web") {
    if (service.startArgs.join(" ") !== "run dev:web") {
      await buildWeb();
    }
    await stopService(service);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return startService(service);
  }

  const error = new Error(`Unsupported action: ${action}`);
  error.statusCode = 400;
  throw error;
}

function localOnly(req) {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const server = http.createServer(async (req, res) => {
  try {
    if (!localOnly(req)) {
      sendJson(res, 403, { ok: false, error: "Local access only." });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && url.pathname === "/") {
      sendHtml(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, await allStatus());
      return;
    }

    const match = url.pathname.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
    if (req.method === "POST" && match) {
      const result = await handleAction(match[1], match[2]);
      sendJson(res, 200, { ok: true, result, status: await allStatus() });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Manager dashboard listening on http://${HOST}:${PORT}`);
});

function html() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Blog Service Manager</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0c0f12;
      --panel: #171c22;
      --panel-2: #202731;
      --text: #e6edf3;
      --muted: #8b9aaa;
      --line: #2b3540;
      --ok: #42b883;
      --bad: #e05b5b;
      --warn: #d49b37;
      --accent: #5fa8d3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 36px 0;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: end;
      margin-bottom: 24px;
    }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { margin: 0; color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 18px;
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: start;
      margin-bottom: 18px;
    }
    h2 { margin: 0 0 6px; font-size: 18px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 10px;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
    .ok .dot { background: var(--ok); }
    .warn .dot { background: var(--warn); }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--line); }
    div.metric { min-width: 0; background: var(--panel-2); padding: 10px 12px; }
    dt { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    dd { margin: 4px 0 0; overflow-wrap: anywhere; font: 13px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--text);
      padding: 9px 12px;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
    }
    button:hover { border-color: var(--accent); }
    button:disabled { cursor: wait; opacity: .65; }
    .danger:hover { border-color: var(--bad); }
    .primary { background: color-mix(in srgb, var(--accent) 18%, var(--panel-2)); }
    .log {
      margin-top: 18px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #07090b;
      padding: 12px;
      min-height: 46px;
      color: var(--muted);
      font: 12px ui-monospace, SFMono-Regular, Consolas, monospace;
      white-space: pre-wrap;
    }
    @media (max-width: 820px) {
      header { align-items: start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      dl { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Blog Service Manager</h1>
        <p>Local control panel for frontend, backend, Directus, and database status.</p>
      </div>
      <button class="primary" onclick="refresh()">Refresh</button>
    </header>
    <section class="grid" id="cards"></section>
    <pre class="log" id="log">Loading...</pre>
  </main>
  <script>
    const cards = document.getElementById("cards");
    const log = document.getElementById("log");
    let busy = false;

    function badge(item) {
      const ok = item.healthy || item.running;
      const label = item.healthy ? "Healthy" : item.running ? "Running / check failed" : "Stopped";
      const cls = item.healthy ? "ok" : item.running ? "warn" : "";
      return '<span class="badge ' + cls + '"><span class="dot"></span>' + label + '</span>';
    }

    function metric(name, value) {
      return '<div class="metric"><dt>' + name + '</dt><dd>' + (value ?? "N/A") + '</dd></div>';
    }

    function serviceCard(item) {
      const pid = item.pids && item.pids.length ? item.pids.join(", ") : "N/A";
      const rebuild = item.id === "web"
        ? '<button onclick="act(\\'' + item.id + '\\', \\'rebuild-restart\\')">Rebuild + Restart</button>'
        : "";
      return '<article class="card">'
        + '<div class="card-head"><div><h2>' + item.name + '</h2><p>' + item.url + '</p></div>' + badge(item) + '</div>'
        + '<dl>'
        + metric("Port", item.port)
        + metric("PID", pid)
        + metric("HTTP", item.status || item.error || "N/A")
        + metric("Elapsed", item.elapsed != null ? item.elapsed + "ms" : "N/A")
        + '</dl>'
        + '<div class="actions">'
        + '<button onclick="act(\\'' + item.id + '\\', \\'start\\')">Start</button>'
        + '<button onclick="act(\\'' + item.id + '\\', \\'restart\\')">Restart</button>'
        + rebuild
        + '<button class="danger" onclick="act(\\'' + item.id + '\\', \\'stop\\')">Stop</button>'
        + '</div>'
        + '</article>';
    }

    function databaseCard(item) {
      return '<article class="card">'
        + '<div class="card-head"><div><h2>' + item.name + '</h2><p>' + item.path + '</p></div>' + badge(item) + '</div>'
        + '<dl>'
        + metric("Tables", item.tables)
        + metric("Projects", item.projects)
        + metric("Masters", item.masters)
        + metric("Error", item.error || "N/A")
        + '</dl>'
        + '<div class="actions"><button onclick="refresh()">Check</button></div>'
        + '</article>';
    }

    async function refresh() {
      const response = await fetch("/api/status", { cache: "no-store" });
      const data = await response.json();
      cards.innerHTML = data.services.map(serviceCard).join("") + databaseCard(data.database);
      log.textContent = "Updated: " + data.updatedAt;
    }

    async function act(id, action) {
      if (busy) return;
      busy = true;
      document.querySelectorAll("button").forEach((button) => button.disabled = true);
      log.textContent = "Running " + action + " on " + id + "...";
      try {
        const response = await fetch("/api/services/" + id + "/" + action, { method: "POST" });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Action failed");
        log.textContent = data.result.message || "Done.";
        cards.innerHTML = data.status.services.map(serviceCard).join("") + databaseCard(data.status.database);
      } catch (error) {
        log.textContent = "Error: " + error.message;
        await refresh();
      } finally {
        busy = false;
        document.querySelectorAll("button").forEach((button) => button.disabled = false);
      }
    }

    refresh();
    setInterval(() => { if (!busy) refresh(); }, 5000);
  </script>
</body>
</html>`;
}
