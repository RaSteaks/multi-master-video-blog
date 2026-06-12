const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const {
  loadDirectusEnv,
  openDirectusDatabase
} = require("./directus-db-utils.cjs");

const ROOT = path.resolve(__dirname, "..");
const ROOT_ENV = loadEnvFile(path.join(ROOT, ".env"));
const HOST = managerEnv("MANAGER_HOST", "127.0.0.1");
const PORT = Number(managerEnv("MANAGER_PORT", 8070));
const WAIT_MS = Number(managerEnv("MANAGER_WAIT_MS", 30000));
const MANAGER_BASE_PATH = normalizeBasePath(
  managerEnv("MANAGER_BASE_PATH", "/manager")
);
const MANAGER_AUTH_USERNAME =
  managerEnv("MANAGER_AUTH_USERNAME", managerEnv("MANAGER_USER", "admin"));
const MANAGER_AUTH_PASSWORD =
  managerEnv("MANAGER_AUTH_PASSWORD", managerEnv("MANAGER_PASSWORD", ""));
const MANAGER_AUTH_ENABLED = MANAGER_AUTH_PASSWORD.length > 0;
const POSTGRES_SERVICE_NAME =
  managerEnv("POSTGRES_SERVICE_NAME", "postgresql-x64-17");
const WEB_MODE_ENV_KEY = "MANAGER_WEB_MODE";
let currentWebMode = coerceWebMode(
  managerEnv(WEB_MODE_ENV_KEY, managerEnv("WEB_MODE", "development"))
);

const services = [
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "Data",
    kind: "windows-service",
    serviceName: POSTGRES_SERVICE_NAME,
    healthLabel: "Directus DB"
  },
  {
    id: "cms",
    name: "Directus CMS",
    category: "CMS",
    kind: "process",
    port: 8055,
    healthUrl: "http://127.0.0.1:8055/server/health",
    openUrl: "http://127.0.0.1:8055/admin/",
    startArgs: ["run", "start:cms"],
    logName: "cms"
  },
  {
    id: "api",
    name: "Upload API",
    category: "Backend",
    kind: "process",
    port: 8060,
    healthUrl: "http://127.0.0.1:8060/health",
    openUrl: "http://127.0.0.1:8060/health",
    startArgs: ["run", "start:api"],
    logName: "api"
  },
  {
    id: "web",
    name: "Frontend Web",
    category: "Frontend",
    kind: "process",
    port: 3000,
    healthUrl: "http://127.0.0.1:3000/",
    openUrl: "http://127.0.0.1:3000/",
    buildArgs: ["run", "build:web"],
    logName: "web"
  }
];

const serviceMap = new Map(services.map((service) => [service.id, service]));

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

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = unquoteEnvValue(trimmed.slice(separator + 1).trim());
    if (key) values[key] = value;
  }

  return values;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function managerEnv(name, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    return process.env[name];
  }

  if (Object.prototype.hasOwnProperty.call(ROOT_ENV, name)) {
    return ROOT_ENV[name];
  }

  return fallback;
}

function setRootEnvValue(name, value) {
  const filePath = path.join(ROOT, ".env");
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const nextLine = `${name}=${formatEnvValue(value)}`;
  let updated = false;

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    const separator = line.indexOf("=");
    if (separator === -1) return line;

    const key = line.slice(0, separator).trim();
    if (key !== name) return line;

    updated = true;
    return nextLine;
  });

  if (!updated) {
    if (nextLines.length === 0) {
      nextLines.push(nextLine);
    } else if (nextLines[nextLines.length - 1] !== "") {
      nextLines.push(nextLine);
    } else {
      nextLines[nextLines.length - 1] = nextLine;
    }
  }

  fs.writeFileSync(filePath, `${nextLines.join(eol)}${eol}`, "utf8");
  ROOT_ENV[name] = value;
}

function formatEnvValue(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseWebMode(value) {
  const token = String(value || "").trim().toLowerCase();
  if (["prod", "production", "start", "start:web"].includes(token)) {
    return "production";
  }
  if (["dev", "development", "dev:web"].includes(token)) {
    return "development";
  }
  return null;
}

function coerceWebMode(value) {
  return parseWebMode(value) || "development";
}

function webModeLabel(mode) {
  return mode === "production" ? "Production" : "Development";
}

function webStartArgs(mode = currentWebMode) {
  return ["run", mode === "production" ? "start:web" : "dev:web"];
}

function webStartScript(mode = currentWebMode) {
  return mode === "production" ? "start:web" : "dev:web";
}

function sendAuthRequired(res) {
  const body = "Authentication required.";
  res.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Basic realm="Service Manager", charset="UTF-8"'
  });
  res.end(body);
}

function localOnly(req) {
  const address = req.socket.remoteAddress;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function normalizeBasePath(value) {
  const pathValue = String(value || "").trim();
  if (!pathValue || pathValue === "/") return "";
  return `/${pathValue.replace(/^\/+|\/+$/g, "")}`;
}

function stripManagerBasePath(pathname) {
  if (!MANAGER_BASE_PATH) return pathname;
  if (pathname === MANAGER_BASE_PATH) return "/";
  if (pathname.startsWith(`${MANAGER_BASE_PATH}/`)) {
    return pathname.slice(MANAGER_BASE_PATH.length) || "/";
  }
  return pathname;
}

function isAuthenticated(req) {
  if (!MANAGER_AUTH_ENABLED) return true;

  const credentials = parseBasicAuth(req.headers.authorization);
  if (!credentials) return false;

  return (
    timingSafeStringEqual(credentials.username, MANAGER_AUTH_USERNAME) &&
    timingSafeStringEqual(credentials.password, MANAGER_AUTH_PASSWORD)
  );
}

function parseBasicAuth(header) {
  if (!header || typeof header !== "string") return null;

  const [scheme, encoded] = header.split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

function timingSafeStringEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left)).digest();
  const rightHash = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psArray(values) {
  return `@(${values.map((value) => psQuote(value)).join(",")})`;
}

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { cwd: ROOT, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr.trim();
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

async function getPortProcessTree(port) {
  const command = [
    `$owners = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue |`,
    "Where-Object { $_.State -eq 'Listen' -and $_.OwningProcess } |",
    "Select-Object -ExpandProperty OwningProcess -Unique;",
    "$processes = Get-CimInstance Win32_Process;",
    "$byId = @{};",
    "$processes | ForEach-Object { $byId[[int]$_.ProcessId] = $_ };",
    "$rows = @();",
    "foreach ($owner in $owners) {",
    "$current = [int]$owner;",
    "$depth = 0;",
    "while ($current -and $byId.ContainsKey($current)) {",
    "$proc = $byId[$current];",
    "$name = [string]$proc.Name;",
    "$allowedAncestor = @('node.exe','cmd.exe') -contains $name.ToLowerInvariant();",
    "if ($depth -gt 0 -and -not $allowedAncestor) { break }",
    "if (-not ($rows | Where-Object { $_.ProcessId -eq $current })) {",
    "$rows += [pscustomobject]@{",
    "ProcessId = [int]$proc.ProcessId;",
    "ParentProcessId = [int]$proc.ParentProcessId;",
    "Name = $proc.Name;",
    "CommandLine = $proc.CommandLine;",
    "Depth = $depth",
    "}",
    "}",
    "$current = [int]$proc.ParentProcessId;",
    "$depth++;",
    "}",
    "}",
    "$rows | Sort-Object Depth | ConvertTo-Json -Compress"
  ].join(" ");
  const stdout = await runPowerShell(command);
  if (!stdout) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
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

async function waitForProcessHealth(service) {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started < WAIT_MS) {
    const status = await checkHttp(service.healthUrl);
    if (status.ok) return status;
    lastError = status.error || `HTTP ${status.status}`;
    await delay(900);
  }

  throw new Error(
    `${service.name} did not become healthy. Last error: ${lastError}`
  );
}

async function waitForPortStopped(service) {
  const started = Date.now();

  while (Date.now() - started < 12000) {
    const owners = await getPortOwners(service.port);
    if (owners.length === 0) return;
    await delay(500);
  }

  throw new Error(`${service.name} did not stop on port ${service.port}.`);
}

async function startProcessService(service, options = {}) {
  const owners = await getPortOwners(service.port);
  if (owners.length > 0) {
    return {
      ok: true,
      message: `${service.name} is already running.`,
      pids: owners
    };
  }

  const logDir = path.join(ROOT, "logs");
  await fsp.mkdir(logDir, { recursive: true });
  if (
    service.id === "web" &&
    currentWebMode === "production" &&
    !options.skipBuild
  ) {
    await buildWeb();
  }

  const stdout = path.join(logDir, `${service.logName}.out.log`);
  const stderr = path.join(logDir, `${service.logName}.err.log`);
  const startArgs = service.id === "web" ? webStartArgs() : service.startArgs;
  const pidText = await runPowerShell(
    [
      "$process = Start-Process",
      "-FilePath 'npm.cmd'",
      `-ArgumentList ${psArray(startArgs)}`,
      `-WorkingDirectory ${psQuote(ROOT)}`,
      `-RedirectStandardOutput ${psQuote(stdout)}`,
      `-RedirectStandardError ${psQuote(stderr)}`,
      "-WindowStyle Hidden",
      "-PassThru;",
      "Write-Output $process.Id"
    ].join(" ")
  );

  await waitForProcessHealth(service);
  return {
    ok: true,
    message:
      service.id === "web"
        ? `Started ${service.name} in ${webModeLabel(currentWebMode)} mode.`
        : `Started ${service.name}.`,
    pid: Number(pidText) || null
  };
}

async function stopProcessService(service) {
  const targets = await getPortProcessTree(service.port);
  if (targets.length === 0) {
    return { ok: true, message: `${service.name} is already stopped.` };
  }

  const ids = targets.map((target) => Number(target.ProcessId)).filter(Boolean);
  const idList = ids.join(",");
  await runPowerShell(
    [
      `foreach ($id in @(${idList})) {`,
      "$proc = Get-Process -Id $id -ErrorAction SilentlyContinue;",
      "if ($proc) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
      "}"
    ].join(" ")
  );
  await waitForPortStopped(service);
  return { ok: true, message: `Stopped ${service.name}.`, pids: ids };
}

async function buildWeb() {
  const web = serviceMap.get("web");
  const logDir = path.join(ROOT, "logs");
  await fsp.mkdir(logDir, { recursive: true });
  const stdout = path.join(logDir, "web.build.out.log");
  const stderr = path.join(logDir, "web.build.err.log");
  const exitCode = await runPowerShell(
    [
      "$process = Start-Process",
      "-FilePath 'npm.cmd'",
      `-ArgumentList ${psArray(web.buildArgs)}`,
      `-WorkingDirectory ${psQuote(ROOT)}`,
      `-RedirectStandardOutput ${psQuote(stdout)}`,
      `-RedirectStandardError ${psQuote(stderr)}`,
      "-WindowStyle Hidden",
      "-Wait",
      "-PassThru;",
      "Write-Output $process.ExitCode"
    ].join(" ")
  );

  if (Number(exitCode) !== 0) {
    throw new Error(
      `Web build failed with exit code ${exitCode}. Check logs/web.build.err.log.`
    );
  }
}

async function getWindowsServiceState(serviceName) {
  const command = [
    `$svc = Get-Service -Name ${psQuote(serviceName)} -ErrorAction SilentlyContinue;`,
    "if (-not $svc) { throw 'Windows service not found.' }",
    "$item = [pscustomobject]@{",
    "Name = $svc.Name;",
    "DisplayName = $svc.DisplayName;",
    "Status = $svc.Status.ToString();",
    "StartType = $svc.StartType.ToString()",
    "};",
    "$item | ConvertTo-Json -Compress"
  ].join(" ");

  const stdout = await runPowerShell(command);
  return JSON.parse(stdout);
}

async function waitForWindowsService(serviceName, expectedStatus) {
  const command = [
    `$deadline = (Get-Date).AddSeconds(${Math.ceil(WAIT_MS / 1000)});`,
    "do {",
    `$svc = Get-Service -Name ${psQuote(serviceName)} -ErrorAction Stop;`,
    `if ($svc.Status -eq ${psQuote(expectedStatus)}) { Write-Output $svc.Status; exit 0 }`,
    "Start-Sleep -Milliseconds 700;",
    "} while ((Get-Date) -lt $deadline);",
    `throw "Service did not reach ${expectedStatus}."`
  ].join(" ");
  await runPowerShell(command);
}

async function startWindowsService(service) {
  const state = await getWindowsServiceState(service.serviceName).catch(() => null);
  if (state?.Status === "Running") {
    return { ok: true, message: `${service.name} is already running.` };
  }

  await runPowerShell(`Start-Service -Name ${psQuote(service.serviceName)}`);
  await waitForWindowsService(service.serviceName, "Running");
  return { ok: true, message: `Started ${service.name}.` };
}

async function stopWindowsService(service) {
  const state = await getWindowsServiceState(service.serviceName).catch(() => null);
  if (state?.Status === "Stopped") {
    return { ok: true, message: `${service.name} is already stopped.` };
  }

  await runPowerShell(`Stop-Service -Name ${psQuote(service.serviceName)} -Force`);
  await waitForWindowsService(service.serviceName, "Stopped");
  return { ok: true, message: `Stopped ${service.name}.` };
}

async function getProcessServiceStatus(service) {
  const [owners, httpStatus] = await Promise.all([
    getPortOwners(service.port).catch(() => []),
    checkHttp(service.healthUrl)
  ]);

  const status = {
    id: service.id,
    name: service.name,
    category: service.category,
    kind: service.kind,
    port: service.port,
    healthUrl: service.healthUrl,
    openUrl: service.openUrl,
    running: owners.length > 0,
    pids: owners,
    healthy: httpStatus.ok,
    status: httpStatus.status || null,
    error: httpStatus.error || null,
    elapsed: httpStatus.elapsed,
    logName: service.logName
  };

  if (service.id === "web") {
    status.mode = currentWebMode;
    status.modeLabel = webModeLabel(currentWebMode);
    status.startScript = webStartScript(currentWebMode);
  }

  return status;
}

async function getWindowsServiceStatus(service, databaseStatus) {
  try {
    const state = await getWindowsServiceState(service.serviceName);
    const running = state.Status === "Running";
    return {
      id: service.id,
      name: service.name,
      category: service.category,
      kind: service.kind,
      serviceName: service.serviceName,
      running,
      healthy: running && databaseStatus.healthy,
      status: state.Status,
      startType: state.StartType,
      displayName: state.DisplayName,
      healthLabel: service.healthLabel,
      error: running ? databaseStatus.error || null : null
    };
  } catch (error) {
    return {
      id: service.id,
      name: service.name,
      category: service.category,
      kind: service.kind,
      serviceName: service.serviceName,
      running: false,
      healthy: false,
      status: "Missing",
      error: cleanPowerShellError(error)
    };
  }
}

async function getServiceStatus(service, databaseStatus) {
  if (service.kind === "windows-service") {
    return getWindowsServiceStatus(service, databaseStatus);
  }

  return getProcessServiceStatus(service);
}

async function getDatabaseStatus() {
  let db = null;

  try {
    db = await openDirectusDatabase(loadDirectusEnv());
    const tables = await db.listTables();
    const projects = await countTableRows(db, "video_projects", tables);
    const masters = await countTableRows(db, "video_masters", tables);
    const posts = await countTableRows(db, "posts", tables);

    return {
      id: "database",
      name: db.name,
      healthy: true,
      running: true,
      path: db.path,
      tables: tables.length,
      posts,
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

function managerStatus() {
  return {
    id: "manager",
    name: "Service Manager",
    host: HOST,
    port: PORT,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    node: process.version,
    platform: process.platform
  };
}

async function allStatus() {
  const database = await getDatabaseStatus();
  const serviceStatuses = await Promise.all(
    services.map((service) => getServiceStatus(service, database))
  );

  return {
    updatedAt: new Date().toISOString(),
    manager: managerStatus(),
    services: serviceStatuses,
    database
  };
}

async function handleAction(serviceId, action) {
  const service = serviceMap.get(serviceId);
  if (!service) {
    const error = new Error(`Unknown service: ${serviceId}`);
    error.statusCode = 404;
    throw error;
  }

  if (service.kind === "windows-service") {
    if (action === "start") return startWindowsService(service);
    if (action === "stop") return stopWindowsService(service);
    if (action === "restart") {
      await stopWindowsService(service);
      await delay(1000);
      return startWindowsService(service);
    }
  }

  if (service.kind === "process") {
    if (action === "start") return startProcessService(service);
    if (action === "stop") return stopProcessService(service);
    if (action === "restart") {
      await stopProcessService(service);
      await delay(1000);
      return startProcessService(service);
    }
    if (action === "rebuild-restart" && service.id === "web") {
      await buildWeb();
      await stopProcessService(service);
      await delay(1000);
      return startProcessService(service, { skipBuild: true });
    }
  }

  const error = new Error(`Unsupported action: ${action}`);
  error.statusCode = 400;
  throw error;
}

async function handleWebModeChange(modeValue) {
  const nextMode = parseWebMode(modeValue);
  if (!nextMode) {
    const error = new Error(`Unsupported web mode: ${modeValue}`);
    error.statusCode = 400;
    throw error;
  }

  if (nextMode === currentWebMode) {
    return {
      ok: true,
      mode: currentWebMode,
      message: `Frontend Web is already in ${webModeLabel(currentWebMode)} mode.`
    };
  }

  const web = serviceMap.get("web");
  if (nextMode === "production") {
    await buildWeb();
  }

  setRootEnvValue(WEB_MODE_ENV_KEY, nextMode);
  currentWebMode = nextMode;
  await stopProcessService(web);
  await delay(1000);
  await startProcessService(web, { skipBuild: nextMode === "production" });

  return {
    ok: true,
    mode: currentWebMode,
    message: `Frontend Web switched to ${webModeLabel(currentWebMode)} mode and restarted.`
  };
}

async function handleStackAction(action) {
  if (action === "start-all") {
    return runStackActions(["postgres", "cms", "api", "web"], "start");
  }

  if (action === "stop-all") {
    return runStackActions(["web", "api", "cms", "postgres"], "stop");
  }

  if (action === "restart-all") {
    await runStackActions(["web", "api", "cms", "postgres"], "stop");
    await delay(1000);
    return runStackActions(["postgres", "cms", "api", "web"], "start");
  }

  const error = new Error(`Unsupported stack action: ${action}`);
  error.statusCode = 400;
  throw error;
}

async function runStackActions(serviceIds, action) {
  const results = [];

  for (const serviceId of serviceIds) {
    try {
      const result = await handleAction(serviceId, action);
      results.push({ serviceId, ok: true, message: result.message });
    } catch (error) {
      results.push({
        serviceId,
        ok: false,
        message: cleanPowerShellError(error)
      });
    }
  }

  const failed = results.filter((item) => !item.ok);
  if (failed.length > 0) {
    const error = new Error(
      failed.map((item) => `${item.serviceId}: ${item.message}`).join("; ")
    );
    error.statusCode = 500;
    error.results = results;
    throw error;
  }

  return {
    ok: true,
    message: `${action} completed.`,
    results
  };
}

async function readServiceLogs(serviceId) {
  const service = serviceMap.get(serviceId);
  if (!service || !service.logName) {
    const error = new Error(`No logs configured for service: ${serviceId}`);
    error.statusCode = 404;
    throw error;
  }

  const logDir = path.join(ROOT, "logs");
  const stdoutPath = path.join(logDir, `${service.logName}.out.log`);
  const stderrPath = path.join(logDir, `${service.logName}.err.log`);

  return {
    serviceId,
    stdout: await tailFile(stdoutPath),
    stderr: await tailFile(stderrPath),
    files: {
      stdout: path.relative(ROOT, stdoutPath),
      stderr: path.relative(ROOT, stderrPath)
    }
  };
}

async function tailFile(filePath, maxBytes = 7000) {
  try {
    const stat = await fsp.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function cleanPowerShellError(error) {
  return String(error.stderr || error.message || error).trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = http.createServer(async (req, res) => {
  try {
    if (!localOnly(req)) {
      sendJson(res, 403, { ok: false, error: "Local access only." });
      return;
    }

    if (!isAuthenticated(req)) {
      sendAuthRequired(res);
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = stripManagerBasePath(url.pathname);

    if (req.method === "GET" && pathname === "/") {
      sendHtml(res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/status") {
      sendJson(res, 200, await allStatus());
      return;
    }

    const logsMatch = pathname.match(/^\/api\/logs\/([^/]+)$/);
    if (req.method === "GET" && logsMatch) {
      sendJson(res, 200, await readServiceLogs(logsMatch[1]));
      return;
    }

    const stackMatch = pathname.match(/^\/api\/stack\/([^/]+)$/);
    if (req.method === "POST" && stackMatch) {
      const result = await handleStackAction(stackMatch[1]);
      sendJson(res, 200, { ok: true, result, status: await allStatus() });
      return;
    }

    const webModeMatch = pathname.match(/^\/api\/services\/web\/mode\/([^/]+)$/);
    if (req.method === "POST" && webModeMatch) {
      const result = await handleWebModeChange(webModeMatch[1]);
      sendJson(res, 200, { ok: true, result, status: await allStatus() });
      return;
    }

    const serviceMatch = pathname.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
    if (req.method === "POST" && serviceMatch) {
      const result = await handleAction(serviceMatch[1], serviceMatch[2]);
      sendJson(res, 200, { ok: true, result, status: await allStatus() });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      ok: false,
      error: cleanPowerShellError(error),
      results: error.results || undefined
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Service Manager is already running or port ${PORT} is in use.`
    );
    console.error(`Open http://${HOST}:${PORT} or run npm run manager:stop first.`);
    process.exitCode = 1;
    return;
  }

  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Service Manager listening on http://${HOST}:${PORT}`);
  if (MANAGER_BASE_PATH) {
    console.log(`Service Manager base path: ${MANAGER_BASE_PATH}`);
  }
  console.log(
    `Service Manager auth: ${MANAGER_AUTH_ENABLED ? `enabled for ${MANAGER_AUTH_USERNAME}` : "disabled"}`
  );
});

function html() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Service Manager</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #10100f;
      --surface: #191a18;
      --surface-2: #22231f;
      --surface-3: #2b2c27;
      --text: #f1efe6;
      --muted: #aaa69a;
      --line: #383a34;
      --green: #45c075;
      --red: #ee6352;
      --amber: #d6a23a;
      --blue: #65a7d8;
      --ink: #090a09;
      --shadow: 0 18px 50px rgba(0, 0, 0, .28);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(255,255,255,.035), transparent 260px),
        repeating-linear-gradient(90deg, rgba(255,255,255,.025) 0 1px, transparent 1px 72px),
        var(--bg);
      color: var(--text);
      font-family: Aptos, "Segoe UI", Tahoma, sans-serif;
    }

    button, input, select { font: inherit; }

    a { color: inherit; text-decoration: none; }

    main {
      width: min(1320px, calc(100% - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: end;
      margin-bottom: 18px;
    }

    .eyebrow {
      margin: 0 0 8px;
      color: var(--amber);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .14em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: clamp(26px, 3vw, 42px);
      line-height: 1;
      letter-spacing: 0;
    }

    .subhead {
      margin: 10px 0 0;
      color: var(--muted);
      max-width: 720px;
      font-size: 14px;
      line-height: 1.6;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }

    .button {
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface-2);
      color: var(--text);
      padding: 0 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: border-color .16s ease, background .16s ease, transform .16s ease;
      white-space: nowrap;
    }

    .button:hover {
      border-color: var(--blue);
      background: #26313a;
    }

    .button:active { transform: translateY(1px); }

    .button:disabled {
      cursor: wait;
      opacity: .58;
      transform: none;
    }

    .button.primary {
      border-color: rgba(101, 167, 216, .62);
      background: #1d3340;
    }

    .button.warn:hover { border-color: var(--amber); background: #372b17; }
    .button.danger:hover { border-color: var(--red); background: #3a211d; }

    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }

    .summary-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(25, 26, 24, .88);
      padding: 12px;
      box-shadow: var(--shadow);
    }

    .summary-item span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }

    .summary-item strong {
      display: block;
      margin-top: 8px;
      font-size: 23px;
      line-height: 1;
      font-family: Bahnschrift, "Segoe UI", sans-serif;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: 16px;
      align-items: start;
    }

    .service-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    .service-card,
    .side-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(25, 26, 24, .94);
      box-shadow: var(--shadow);
    }

    .service-card {
      min-width: 0;
      overflow: hidden;
    }

    .service-head {
      min-height: 92px;
      padding: 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,.035), transparent);
    }

    .service-title {
      min-width: 0;
    }

    h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }

    .service-meta {
      margin: 7px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .badge {
      flex: 0 0 auto;
      min-width: 96px;
      height: 30px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--red);
      box-shadow: 0 0 0 3px rgba(238, 99, 82, .12);
    }

    .badge.ok .dot {
      background: var(--green);
      box-shadow: 0 0 0 3px rgba(69, 192, 117, .14);
    }

    .badge.warn .dot {
      background: var(--amber);
      box-shadow: 0 0 0 3px rgba(214, 162, 58, .13);
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      border-bottom: 1px solid var(--line);
    }

    .metric {
      min-width: 0;
      min-height: 64px;
      padding: 12px 14px;
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }

    .metric:nth-child(2n) { border-right: 0; }
    .metric:nth-last-child(-n+2) { border-bottom: 0; }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 10px;
      font-weight: 900;
      letter-spacing: .1em;
      text-transform: uppercase;
    }

    .metric strong {
      display: block;
      margin-top: 7px;
      font-size: 13px;
      font-family: Consolas, "Cascadia Mono", monospace;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .service-actions {
      min-height: 61px;
      padding: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      background: var(--surface);
    }

    .mode-switch {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 5px;
      background: var(--ink);
    }

    .mode-switch .button {
      width: 100%;
      min-height: 34px;
      border-color: transparent;
      background: transparent;
      color: var(--muted);
    }

    .mode-switch .button.active {
      border-color: rgba(101, 167, 216, .58);
      background: #1d3340;
      color: var(--text);
    }

    .service-actions .button {
      height: 36px;
      min-height: 36px;
      padding-inline: 10px;
      font-size: 13px;
    }

    .side-panel {
      position: sticky;
      top: 16px;
      overflow: hidden;
    }

    .panel-section {
      padding: 16px;
      border-bottom: 1px solid var(--line);
    }

    .panel-section:last-child { border-bottom: 0; }

    .panel-title {
      margin: 0 0 12px;
      font-size: 13px;
      font-weight: 900;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .kv {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 8px 10px;
      font-size: 13px;
    }

    .kv span {
      color: var(--muted);
      font-size: 12px;
    }

    .kv strong {
      min-width: 0;
      font-family: Consolas, "Cascadia Mono", monospace;
      font-size: 12px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .log {
      width: 100%;
      min-height: 190px;
      max-height: 420px;
      margin: 0;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--ink);
      color: #d7d2c4;
      padding: 12px;
      font: 12px/1.5 Consolas, "Cascadia Mono", monospace;
      white-space: pre-wrap;
    }

    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 10;
      max-width: min(460px, calc(100vw - 36px));
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #1b1c19;
      box-shadow: var(--shadow);
      padding: 12px 14px;
      color: var(--text);
      font-size: 13px;
      line-height: 1.45;
      transform: translateY(16px);
      opacity: 0;
      pointer-events: none;
      transition: transform .18s ease, opacity .18s ease;
      overflow-wrap: anywhere;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    @media (max-width: 1080px) {
      .layout { grid-template-columns: 1fr; }
      .side-panel { position: static; }
    }

    @media (max-width: 760px) {
      main { width: min(100% - 20px, 1320px); padding-top: 18px; }
      .topbar { grid-template-columns: 1fr; align-items: start; }
      .toolbar { justify-content: flex-start; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .service-grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: 1fr; }
      .metric,
      .metric:nth-child(2n),
      .metric:nth-last-child(-n+2) {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .metric:last-child { border-bottom: 0; }
      .service-head { min-height: auto; }
    }
  </style>
</head>
<body>
  <main>
    <header class="topbar">
      <div>
        <p class="eyebrow">Local stack control</p>
        <h1>Service Manager</h1>
        <p class="subhead">Start, stop, restart, and inspect the local web stack from one process.</p>
      </div>
      <div class="toolbar">
        <button class="button primary" data-stack="start-all">Start All</button>
        <button class="button warn" data-stack="restart-all">Restart All</button>
        <button class="button danger" data-stack="stop-all">Stop All</button>
        <button class="button" id="refreshButton">Refresh</button>
      </div>
    </header>

    <section class="summary" id="summary"></section>

    <section class="layout">
      <div class="service-grid" id="cards"></div>
      <aside class="side-panel">
        <section class="panel-section">
          <h2 class="panel-title">Manager</h2>
          <div class="kv" id="managerMeta"></div>
        </section>
        <section class="panel-section">
          <h2 class="panel-title">Database</h2>
          <div class="kv" id="databaseMeta"></div>
        </section>
        <section class="panel-section">
          <h2 class="panel-title">Output</h2>
          <pre class="log" id="log">Loading...</pre>
        </section>
      </aside>
    </section>
  </main>
  <div class="toast" id="toast"></div>

  <script>
    const API_BASE = ${JSON.stringify(MANAGER_BASE_PATH)};
    const cards = document.getElementById("cards");
    const summary = document.getElementById("summary");
    const managerMeta = document.getElementById("managerMeta");
    const databaseMeta = document.getElementById("databaseMeta");
    const log = document.getElementById("log");
    const toast = document.getElementById("toast");
    const refreshButton = document.getElementById("refreshButton");
    let state = null;
    let busy = false;
    let toastTimer = null;

    function esc(value) {
      return String(value ?? "N/A")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function setBusy(nextBusy) {
      busy = nextBusy;
      document.querySelectorAll("button").forEach((button) => {
        button.disabled = nextBusy;
      });
    }

    function notify(message) {
      clearTimeout(toastTimer);
      toast.textContent = message;
      toast.classList.add("show");
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
    }

    function apiPath(path) {
      return API_BASE + path;
    }

    function serviceState(item) {
      if (item.healthy) return { label: "Healthy", cls: "ok" };
      if (item.running) return { label: "Degraded", cls: "warn" };
      return { label: "Stopped", cls: "" };
    }

    function badge(item) {
      const status = serviceState(item);
      return '<span class="badge ' + status.cls + '"><span class="dot"></span>' + status.label + '</span>';
    }

    function metric(label, value) {
      return '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
    }

    function serviceCard(item) {
      const meta = item.kind === "windows-service"
        ? item.serviceName
        : item.healthUrl;
      const pids = item.pids && item.pids.length ? item.pids.join(", ") : "N/A";
      const metrics = item.kind === "windows-service"
        ? [
            metric("Service", item.serviceName),
            metric("Status", item.status),
            metric("Start type", item.startType),
            metric("DB check", item.error || (item.healthy ? "OK" : "N/A"))
          ].join("")
        : item.id === "web"
          ? [
              metric("Port", item.port),
              metric("PID", pids),
              metric("HTTP", item.status || item.error),
              metric("Latency", item.elapsed != null ? item.elapsed + "ms" : "N/A"),
              metric("Mode", item.modeLabel),
              metric("Script", item.startScript)
            ].join("")
        : [
            metric("Port", item.port),
            metric("PID", pids),
            metric("HTTP", item.status || item.error),
            metric("Latency", item.elapsed != null ? item.elapsed + "ms" : "N/A")
          ].join("");
      const open = item.openUrl
        ? '<a class="button" href="' + esc(item.openUrl) + '" target="_blank" rel="noreferrer">Open</a>'
        : "";
      const logs = item.logName
        ? '<button class="button" data-log="' + esc(item.id) + '">Logs</button>'
        : "";
      const rebuild = item.id === "web"
        ? '<button class="button" data-action="rebuild-restart" data-id="' + esc(item.id) + '">Build + Restart</button>'
        : "";
      const webMode = item.id === "web"
        ? '<div class="mode-switch" role="group" aria-label="Frontend Web mode">'
          + '<button class="button ' + (item.mode === "development" ? "active" : "") + '" data-web-mode="development">Development</button>'
          + '<button class="button ' + (item.mode === "production" ? "active" : "") + '" data-web-mode="production">Production</button>'
          + '</div>'
        : "";

      return '<article class="service-card">'
        + '<div class="service-head">'
        + '<div class="service-title"><h2>' + esc(item.name) + '</h2><p class="service-meta">' + esc(item.category) + " / " + esc(meta) + '</p></div>'
        + badge(item)
        + '</div>'
        + '<div class="metrics">' + metrics + '</div>'
        + '<div class="service-actions">'
        + webMode
        + '<button class="button primary" data-action="start" data-id="' + esc(item.id) + '">Start</button>'
        + '<button class="button warn" data-action="restart" data-id="' + esc(item.id) + '">Restart</button>'
        + rebuild
        + '<button class="button danger" data-action="stop" data-id="' + esc(item.id) + '">Stop</button>'
        + open
        + logs
        + '</div>'
        + '</article>';
    }

    function kv(data) {
      return Object.entries(data).map(([key, value]) =>
        '<span>' + esc(key) + '</span><strong>' + esc(value) + '</strong>'
      ).join("");
    }

    function render(data) {
      state = data;
      const running = data.services.filter((item) => item.running).length;
      const healthy = data.services.filter((item) => item.healthy).length;
      const stopped = data.services.length - running;
      summary.innerHTML = [
        summaryItem("Running", running + " / " + data.services.length),
        summaryItem("Healthy", healthy + " / " + data.services.length),
        summaryItem("Stopped", stopped),
        summaryItem("Updated", new Date(data.updatedAt).toLocaleTimeString())
      ].join("");

      cards.innerHTML = data.services.map(serviceCard).join("");
      managerMeta.innerHTML = kv({
        Host: data.manager.host + ":" + data.manager.port,
        PID: data.manager.pid,
        Uptime: data.manager.uptime + "s",
        Node: data.manager.node
      });
      databaseMeta.innerHTML = kv({
        Status: data.database.healthy ? "Healthy" : "Unavailable",
        Path: data.database.path,
        Tables: data.database.tables,
        Posts: data.database.posts,
        Projects: data.database.projects,
        Masters: data.database.masters,
        Error: data.database.error || "N/A"
      });
    }

    function summaryItem(label, value) {
      return '<div class="summary-item"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
    }

    async function refresh(silent = false) {
      if (!silent) log.textContent = "Refreshing status...";
      const response = await fetch(apiPath("/api/status"), { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Status request failed");
      render(data);
      if (!silent) log.textContent = "Status refreshed at " + new Date(data.updatedAt).toLocaleString();
    }

    async function runServiceAction(id, action) {
      if (busy) return;
      setBusy(true);
      log.textContent = "Running " + action + " on " + id + "...";
      try {
        const response = await fetch(apiPath("/api/services/" + encodeURIComponent(id) + "/" + encodeURIComponent(action)), {
          method: "POST"
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Action failed");
        render(data.status);
        const message = data.result.message || "Done.";
        log.textContent = message;
        notify(message);
      } catch (error) {
        log.textContent = "Error: " + error.message;
        notify(error.message);
        await refresh(true).catch(() => {});
      } finally {
        setBusy(false);
      }
    }

    async function runStackAction(action) {
      if (busy) return;
      if (action === "stop-all" && !confirm("Stop all managed services, including PostgreSQL?")) return;
      if (action === "restart-all" && !confirm("Restart the full managed stack?")) return;
      setBusy(true);
      log.textContent = "Running " + action + "...";
      try {
        const response = await fetch(apiPath("/api/stack/" + encodeURIComponent(action)), { method: "POST" });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.error || "Stack action failed");
        }
        render(data.status);
        log.textContent = (data.result.results || [])
          .map((item) => item.serviceId + ": " + item.message)
          .join("\\n");
        notify(data.result.message || "Done.");
      } catch (error) {
        log.textContent = "Error: " + error.message;
        notify(error.message);
        await refresh(true).catch(() => {});
      } finally {
        setBusy(false);
      }
    }

    async function setWebMode(mode) {
      if (busy) return;
      const nextLabel = mode === "production" ? "Production" : "Development";
      const current = state?.services?.find((item) => item.id === "web")?.mode;
      if (current === mode) {
        notify("Frontend Web is already in " + nextLabel + " mode.");
        return;
      }

      if (mode === "production" && !confirm("Switch Frontend Web to Production mode? This will build and restart the frontend.")) {
        return;
      }

      setBusy(true);
      log.textContent = "Switching Frontend Web to " + nextLabel + " mode...";
      try {
        const response = await fetch(apiPath("/api/services/web/mode/" + encodeURIComponent(mode)), {
          method: "POST"
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Mode switch failed");
        render(data.status);
        const message = data.result.message || "Frontend Web mode switched.";
        log.textContent = message;
        notify(message);
      } catch (error) {
        log.textContent = "Error: " + error.message;
        notify(error.message);
        await refresh(true).catch(() => {});
      } finally {
        setBusy(false);
      }
    }

    async function loadLogs(id) {
      if (busy) return;
      log.textContent = "Loading logs for " + id + "...";
      try {
        const response = await fetch(apiPath("/api/logs/" + encodeURIComponent(id)), { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Log request failed");
        log.textContent = [
          "== " + data.files.stdout + " ==",
          data.stdout || "(empty)",
          "",
          "== " + data.files.stderr + " ==",
          data.stderr || "(empty)"
        ].join("\\n");
      } catch (error) {
        log.textContent = "Error: " + error.message;
        notify(error.message);
      }
    }

    document.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-action]");
      if (actionButton) {
        runServiceAction(actionButton.dataset.id, actionButton.dataset.action);
        return;
      }

      const stackButton = event.target.closest("[data-stack]");
      if (stackButton) {
        runStackAction(stackButton.dataset.stack);
        return;
      }

      const logButton = event.target.closest("[data-log]");
      if (logButton) {
        loadLogs(logButton.dataset.log);
        return;
      }

      const modeButton = event.target.closest("[data-web-mode]");
      if (modeButton) {
        setWebMode(modeButton.dataset.webMode);
      }
    });

    refreshButton.addEventListener("click", () => refresh());
    refresh().catch((error) => {
      log.textContent = "Error: " + error.message;
      notify(error.message);
    });
    setInterval(() => {
      if (!busy) refresh(true).catch(() => {});
    }, 5000);
  </script>
</body>
</html>`;
}
