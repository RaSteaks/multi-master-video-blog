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
const API_ENV_PATH = path.join(ROOT, "apps", "api", ".env");
const API_ENV_LABEL = "apps/api/.env";
const UPLOAD_TOKEN_PLACEHOLDERS = new Set([
  "__REPLACE_WITH_RANDOM_UPLOAD_TOKEN__",
  "__REPLACE_WITH_RANDOM_ARTICLE_TOKEN__"
]);
const TOKEN_MIN_LENGTH = 24;
const TOKEN_MAX_LENGTH = 256;
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

function setEnvValues(filePath, updates) {
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const content = existing.replace(/(?:\r?\n)+$/, "");
  const lines = content ? content.split(/\r?\n/) : [];
  const values = new Map(
    Object.entries(updates).map(([name, value]) => [name, String(value)])
  );
  const updated = new Set();

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    const separator = line.indexOf("=");
    if (separator === -1) return line;

    const key = line.slice(0, separator).trim();
    if (!values.has(key)) return line;

    const nextLine = `${key}=${formatEnvValue(values.get(key))}`;
    updated.add(key);
    return nextLine;
  });

  const pending = [...values].filter(([name]) => !updated.has(name));
  if (pending.length > 0 && nextLines.length > 0 && nextLines.at(-1) !== "") {
    nextLines.push("");
  }

  for (const [name, value] of pending) {
    nextLines.push(`${name}=${formatEnvValue(value)}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${nextLines.join(eol)}${eol}`, "utf8");
}

function setRootEnvValue(name, value) {
  setEnvValues(path.join(ROOT, ".env"), { [name]: value });
  ROOT_ENV[name] = String(value);
}

function formatEnvValue(value) {
  const text = String(value);
  if (!text) return "";
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function configuredToken(value) {
  const token = String(value || "").trim();
  return token && !UPLOAD_TOKEN_PLACEHOLDERS.has(token) ? token : "";
}

function maskedToken(token) {
  if (!token) return "Not configured";
  const fingerprint = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `•••••••• · ${fingerprint}`;
}

function uploadTokenStatus() {
  const env = loadEnvFile(API_ENV_PATH);
  const uploadToken = configuredToken(env.UPLOAD_API_TOKEN);
  const ownArticleToken = configuredToken(env.ARTICLE_API_TOKEN);
  const articleToken = ownArticleToken || uploadToken;

  return {
    path: API_ENV_LABEL,
    tokens: [
      {
        id: "upload",
        envKey: "UPLOAD_API_TOKEN",
        label: "Video & albums",
        configured: Boolean(uploadToken),
        inherited: false,
        masked: maskedToken(uploadToken)
      },
      {
        id: "article",
        envKey: "ARTICLE_API_TOKEN",
        label: "Articles",
        configured: Boolean(articleToken),
        inherited: !ownArticleToken && Boolean(uploadToken),
        masked: maskedToken(articleToken)
      }
    ]
  };
}

function validateManagedToken(value, label) {
  const token = String(value || "").trim();
  if (!token) return "";
  if (token.length < TOKEN_MIN_LENGTH || token.length > TOKEN_MAX_LENGTH) {
    const error = new Error(
      `${label} must be ${TOKEN_MIN_LENGTH}-${TOKEN_MAX_LENGTH} characters.`
    );
    error.statusCode = 400;
    throw error;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    const error = new Error(
      `${label} may only contain letters, numbers, hyphens, and underscores.`
    );
    error.statusCode = 400;
    throw error;
  }
  if (UPLOAD_TOKEN_PLACEHOLDERS.has(token)) {
    const error = new Error(`${label} cannot use a disabled placeholder value.`);
    error.statusCode = 400;
    throw error;
  }
  return token;
}

async function readJsonBody(req, maxBytes = 8192) {
  const contentType = String(req.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type must be application/json.");
    error.statusCode = 415;
    throw error;
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!body || Array.isArray(body) || typeof body !== "object") {
      throw new Error("Request body must be a JSON object.");
    }
    return body;
  } catch (cause) {
    const error = new Error(cause.message || "Invalid JSON request body.");
    error.statusCode = 400;
    throw error;
  }
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
    "$owners = @();",
    "try {",
    `$owners = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue |`,
    "Where-Object { $_.State -eq 'Listen' -and $_.OwningProcess } |",
    "Select-Object -ExpandProperty OwningProcess -Unique;",
    "} catch {}",
    "if (-not $owners) {",
    `$pattern = '^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$';`,
    "$owners = netstat.exe -ano -p TCP | ForEach-Object {",
    "if ($_ -match $pattern) { [int]$Matches[1] }",
    "} | Sort-Object -Unique;",
    "}",
    "$owners"
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
  const running = owners.length > 0 || httpStatus.status != null;

  const status = {
    id: service.id,
    name: service.name,
    category: service.category,
    kind: service.kind,
    port: service.port,
    healthUrl: service.healthUrl,
    openUrl: service.openUrl,
    running,
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
    database,
    uploadTokens: uploadTokenStatus()
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

async function handleUploadTokenChange(payload) {
  const updates = {};
  const uploadToken = validateManagedToken(
    payload.uploadToken,
    "Video and album token"
  );
  const articleToken = validateManagedToken(
    payload.articleToken,
    "Article token"
  );

  if (uploadToken) {
    updates.UPLOAD_API_TOKEN = uploadToken;
  }

  if (payload.articleUsesUploadToken === true) {
    updates.ARTICLE_API_TOKEN = "";
  } else if (articleToken) {
    updates.ARTICLE_API_TOKEN = articleToken;
  }

  if (Object.keys(updates).length === 0) {
    const error = new Error("Enter at least one new token or enable token sharing.");
    error.statusCode = 400;
    throw error;
  }

  setEnvValues(API_ENV_PATH, updates);

  let restartOk = true;
  let restartMessage = "Upload API restarted.";
  try {
    const result = await handleAction("api", "restart");
    restartMessage = result.message || restartMessage;
  } catch (error) {
    restartOk = false;
    restartMessage = cleanPowerShellError(error);
  }

  const changedLabels = [
    updates.UPLOAD_API_TOKEN !== undefined ? "video and album" : "",
    updates.ARTICLE_API_TOKEN !== undefined ? "article" : ""
  ].filter(Boolean);
  const message = restartOk
    ? `Updated the ${changedLabels.join(" and ")} token settings. ${restartMessage}`
    : `Token settings were saved, but the Upload API could not restart: ${restartMessage}`;

  return {
    ok: true,
    restartOk,
    message,
    uploadTokens: uploadTokenStatus()
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
  const service = serviceId === "manager"
    ? { id: "manager", name: "Service Manager", logName: "manager" }
    : serviceMap.get(serviceId);
  if (!service?.logName) {
    const error = new Error(`No logs configured for service: ${serviceId}`);
    error.statusCode = 404;
    throw error;
  }

  const logDir = path.join(ROOT, "logs");
  const stdoutPath = path.join(logDir, `${service.logName}.out.log`);
  const stderrPath = path.join(logDir, `${service.logName}.err.log`);

  return {
    serviceId,
    serviceName: service.name,
    updatedAt: new Date().toISOString(),
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

    if (req.method === "POST" && pathname === "/api/upload-tokens") {
      const result = await handleUploadTokenChange(await readJsonBody(req));
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
    /* ========================================================================
       MMVB Master Control — "Reference Room" console
       Aligned with the site design system (SMPTE RP 431-2 inspired):
       amber signals · steel-blue reference · neutral near-black surround
       ======================================================================== */
    :root {
      color-scheme: dark;
      --bg: #0C0E10;
      --surface: #161A1E;
      --surface-raised: #1E2328;
      --surface-overlay: #252C34;
      --surface-deep: #08090B;
      --text: #E2E8EE;
      --text-2: #9AAABB;
      --faint: #536070;
      --line: #222A32;
      --line-light: #2C3840;
      --amber: #D4922A;
      --amber-bright: #E9AE4F;
      --amber-ink: #1A1206;
      --blue: #4890C2;
      --blue-bright: #7FB8D8;
      --green: #3DA87A;
      --green-bright: #6BC9A0;
      --red: #D45252;
      --red-bright: #FF9DA0;
      --font-display: Bahnschrift, "Segoe UI", "Microsoft YaHei UI", sans-serif;
      --font-mono: "Cascadia Mono", "JetBrains Mono", Consolas, monospace;
      --radius: 6px;
      --shadow: 0 18px 44px rgba(0, 0, 0, .38);
      --shadow-tight: 0 8px 20px rgba(0, 0, 0, .3);
    }

    * { box-sizing: border-box; }

    ::selection {
      background: rgba(212, 146, 42, .32);
      color: #fff;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(1100px 480px at 18% -6%, rgba(212, 146, 42, .05), transparent 70%),
        radial-gradient(900px 420px at 90% 112%, rgba(72, 144, 194, .05), transparent 70%),
        linear-gradient(rgba(154, 170, 187, .045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(154, 170, 187, .045) 1px, transparent 1px),
        var(--bg);
      background-size: auto, auto, 44px 44px, 44px 44px, auto;
      color: var(--text);
      font-family: var(--font-display);
      font-size: 14px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }

    /* SMPTE reference bars — muted seven-strip signature along the top edge */
    body::before {
      content: "";
      position: fixed;
      inset: 0 0 auto;
      z-index: 50;
      height: 3px;
      background: linear-gradient(90deg,
        #b4b4b4 0%, #b4b4b4 14.28%,
        #b4b44b 14.28%, #b4b44b 28.57%,
        #4bb4b4 28.57%, #4bb4b4 42.85%,
        #4bb44b 42.85%, #4bb44b 57.14%,
        #b44bb4 57.14%, #b44bb4 71.42%,
        #b44b4b 71.42%, #b44b4b 85.71%,
        #4b4bb4 85.71%, #4b4bb4 100%);
      opacity: .5;
      pointer-events: none;
    }

    button, input, select { font: inherit; }

    a { color: inherit; text-decoration: none; }

    button, a, input { -webkit-tap-highlight-color: transparent; }

    :focus-visible {
      outline: 2px solid var(--blue-bright);
      outline-offset: 2px;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }

    main {
      width: min(1560px, calc(100% - 28px));
      margin: 0 auto;
      padding: 20px 0 44px;
    }

    /* ---- Buttons -------------------------------------------------------- */
    .button {
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--surface-raised);
      color: var(--text);
      padding: 0 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      font: 600 11px/1 var(--font-display);
      letter-spacing: .06em;
      text-transform: uppercase;
      white-space: nowrap;
      transition: border-color .15s ease, background .15s ease, color .15s ease, transform .15s ease, box-shadow .15s ease;
    }

    .button:hover {
      border-color: var(--line-light);
      background: var(--surface-overlay);
    }

    .button:active { transform: translateY(1px); }

    .button:disabled {
      cursor: wait;
      opacity: .45;
      transform: none;
      box-shadow: none;
    }

    .button.primary {
      border-color: var(--amber);
      background: var(--amber);
      color: var(--amber-ink);
    }

    .button.primary:hover {
      border-color: var(--amber-bright);
      background: var(--amber-bright);
    }

    .button.warn {
      border-color: rgba(72, 144, 194, .5);
      background: rgba(72, 144, 194, .13);
      color: #CFE6F4;
    }

    .button.warn:hover {
      border-color: var(--blue-bright);
      background: rgba(72, 144, 194, .22);
    }

    .button.danger {
      border-color: rgba(212, 82, 82, .5);
      background: rgba(212, 82, 82, .1);
      color: #F6D2D3;
    }

    .button.danger:hover {
      border-color: var(--red-bright);
      background: rgba(212, 82, 82, .2);
    }

    /* ---- Masthead -------------------------------------------------------- */
    .masthead {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 18px 26px;
      align-items: center;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background:
        linear-gradient(115deg, rgba(212, 146, 42, .07), transparent 42%),
        linear-gradient(180deg, rgba(255, 255, 255, .015), transparent),
        var(--surface);
      box-shadow: var(--shadow);
      padding: 16px 18px;
      animation: deck-in .4s ease-out both;
    }

    .masthead::after {
      content: "";
      position: absolute;
      top: 12px;
      right: 14px;
      width: 190px;
      height: 6px;
      background: repeating-linear-gradient(90deg, var(--line-light) 0 2px, transparent 2px 12px);
      opacity: .75;
      pointer-events: none;
    }

    .identity {
      display: flex;
      align-items: center;
      gap: 15px;
      min-width: 0;
    }

    .brand-mark {
      flex: 0 0 46px;
      width: 46px;
      height: 46px;
      display: flex;
      align-items: flex-end;
      gap: 3px;
      border: 1px solid var(--line-light);
      border-radius: 5px;
      background: var(--surface-deep);
      padding: 9px 8px;
      overflow: hidden;
    }

    .brand-mark i {
      flex: 1;
      border-radius: 1px;
      background: linear-gradient(180deg, var(--amber-bright), var(--amber) 70%, #9c6d20);
      transform-origin: bottom;
      animation: vu 1.7s ease-in-out infinite;
    }

    .brand-mark i:nth-child(1) { height: 62%; animation-delay: 0s; }
    .brand-mark i:nth-child(2) { height: 100%; animation-delay: .28s; }
    .brand-mark i:nth-child(3) { height: 44%; animation-delay: .55s; }
    .brand-mark i:nth-child(4) { height: 82%; animation-delay: .12s; }
    .brand-mark i:nth-child(5) { height: 55%; animation-delay: .4s; }

    .identity-copy { min-width: 0; }

    .eyebrow {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin: 0 0 5px;
      color: var(--amber);
      font: 700 10px/1 var(--font-display);
      letter-spacing: .19em;
      text-transform: uppercase;
    }

    .eyebrow-tag {
      padding-left: 10px;
      border-left: 1px solid var(--line-light);
      color: var(--faint);
      font: 600 9px/1 var(--font-mono);
      letter-spacing: .12em;
    }

    h1 {
      margin: 0;
      font: 650 clamp(24px, 2.4vw, 32px)/1 var(--font-display);
      font-stretch: semi-condensed;
      letter-spacing: -.015em;
    }

    .subhead {
      margin: 7px 0 0;
      max-width: 620px;
      color: var(--text-2);
      font-size: 12px;
      line-height: 1.45;
    }

    .tally {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .tally-chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 30px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--surface-raised);
      color: var(--text-2);
      padding: 0 10px;
      cursor: pointer;
      font: 600 10px/1 var(--font-display);
      letter-spacing: .09em;
      text-transform: uppercase;
      transition: border-color .15s ease, color .15s ease, background .15s ease;
    }

    .tally-chip i {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--red);
      box-shadow: 0 0 0 2px rgba(212, 82, 82, .14);
    }

    .tally-chip.ok i {
      background: var(--green);
      box-shadow: 0 0 0 2px rgba(61, 168, 122, .16);
    }

    .tally-chip.warn i {
      background: var(--amber);
      box-shadow: 0 0 0 2px rgba(212, 146, 42, .16);
    }

    .tally-chip:hover {
      border-color: var(--line-light);
      background: var(--surface-overlay);
      color: var(--text);
    }

    .command-deck {
      display: grid;
      gap: 7px;
      justify-items: end;
    }

    .command-label {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 0;
      color: var(--faint);
      font: 600 9px/1 var(--font-mono);
      letter-spacing: .12em;
      text-transform: uppercase;
    }

    .command-label::before {
      content: "";
      width: 18px;
      height: 1px;
      background: var(--line-light);
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
    }

    .toolbar .button {
      min-width: 86px;
      min-height: 38px;
      font-size: 10px;
      letter-spacing: .1em;
    }

    /* ---- Status strip ---------------------------------------------------- */
    .status-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 10px;
      animation: deck-in .4s .05s ease-out both;
    }

    .status-tile {
      position: relative;
      min-width: 0;
      min-height: 72px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      padding: 12px 14px 11px 17px;
      box-shadow: var(--shadow-tight);
    }

    .status-tile::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      background: var(--faint);
      opacity: .6;
    }

    .status-tile.ok::before { background: var(--green); opacity: 1; }
    .status-tile.info::before { background: var(--blue); opacity: 1; }
    .status-tile.alert::before { background: var(--red); opacity: 1; }

    .status-tile::after {
      content: "";
      position: absolute;
      top: 0;
      right: 0;
      width: 14px;
      height: 14px;
      border-top: 1px solid var(--line-light);
      border-right: 1px solid var(--line-light);
      border-top-right-radius: var(--radius);
      opacity: .9;
    }

    .tile-label {
      display: block;
      color: var(--text-2);
      font: 650 9px/1 var(--font-display);
      letter-spacing: .15em;
      text-transform: uppercase;
    }

    .tile-value {
      display: block;
      max-width: 100%;
      margin-top: 9px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 600 21px/1 var(--font-mono);
      letter-spacing: -.03em;
    }

    /* ---- Service bay ------------------------------------------------------ */
    .service-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 10px;
      animation: deck-in .4s .1s ease-out both;
    }

    .service-card {
      position: relative;
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      transition: border-color .18s ease, transform .18s ease, box-shadow .18s ease;
    }

    .service-card::before {
      content: "";
      position: absolute;
      z-index: 1;
      inset: 0 auto 0 0;
      width: 3px;
      background: var(--red);
      opacity: .9;
    }

    .service-card.ok::before { background: var(--green); }
    .service-card.warn::before { background: var(--amber); }

    .service-card:hover {
      border-color: var(--line-light);
      box-shadow: 0 20px 44px rgba(0, 0, 0, .36);
      transform: translateY(-1px);
    }

    .service-card.flash { animation: card-flash 1.3s ease-out; }

    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      min-height: 64px;
      padding: 11px 12px 10px 15px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(90deg, rgba(212, 146, 42, .04), transparent 46%);
    }

    .card-id {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      min-width: 0;
    }

    .card-index {
      flex: 0 0 auto;
      margin-top: 1px;
      border: 1px solid var(--line-light);
      border-radius: 3px;
      background: var(--surface-deep);
      color: var(--faint);
      padding: 3px 5px;
      font: 600 9px/1 var(--font-mono);
      letter-spacing: .08em;
    }

    .card-title { min-width: 0; }

    .card-title h2 {
      margin: 0;
      font: 650 14px/1.2 var(--font-display);
      letter-spacing: -.005em;
      overflow-wrap: anywhere;
    }

    .card-meta {
      margin: 5px 0 0;
      color: var(--text-2);
      font: 9px/1.35 var(--font-mono);
      overflow-wrap: anywhere;
    }

    .badge {
      flex: 0 0 auto;
      min-width: 82px;
      height: 25px;
      border: 1px solid var(--line);
      border-radius: 3px;
      padding: 0 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--text-2);
      font: 700 9px/1 var(--font-display);
      letter-spacing: .09em;
      text-transform: uppercase;
    }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--red);
      box-shadow: 0 0 0 2px rgba(212, 82, 82, .14);
    }

    .badge.ok .dot {
      background: var(--green);
      box-shadow: 0 0 0 2px rgba(61, 168, 122, .15);
      animation: signal-pulse 2.4s ease-in-out infinite;
    }

    .badge.warn .dot {
      background: var(--amber);
      box-shadow: 0 0 0 2px rgba(212, 146, 42, .15);
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .metric {
      min-width: 0;
      min-height: 50px;
      padding: 9px 11px 8px 15px;
      border-bottom: 1px solid var(--line);
      background: rgba(8, 9, 11, .35);
    }

    .metric:nth-child(odd) { border-right: 1px solid var(--line); }
    .metric:nth-last-child(-n+2) { border-bottom: 0; }

    .metric span {
      display: block;
      color: var(--faint);
      font: 650 8px/1 var(--font-display);
      letter-spacing: .15em;
      text-transform: uppercase;
    }

    .metric strong {
      display: block;
      margin-top: 6px;
      color: #D5DEE4;
      font: 550 10px/1.25 var(--font-mono);
      overflow-wrap: anywhere;
    }

    .card-actions {
      margin-top: auto;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
      min-height: 50px;
      padding: 9px 11px 10px 15px;
      border-top: 1px solid var(--line);
      background: rgba(8, 9, 11, .5);
    }

    .mode-switch {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 3px;
      background: var(--surface-deep);
      margin-bottom: 2px;
    }

    .mode-switch .button {
      width: 100%;
      min-height: 28px;
      border-color: transparent;
      background: transparent;
      color: var(--text-2);
      font-size: 9px;
      letter-spacing: .06em;
    }

    .mode-switch .button.active {
      border-color: rgba(212, 146, 42, .5);
      background: rgba(212, 146, 42, .14);
      color: #F2E3C8;
    }

    .card-actions .button {
      height: 29px;
      min-height: 29px;
      padding-inline: 9px;
      font-size: 9.5px;
      letter-spacing: .05em;
    }

    /* ---- Bench: credentials + diagnostics -------------------------------- */
    .bench {
      display: grid;
      grid-template-columns: minmax(0, 1.85fr) minmax(280px, 1fr);
      gap: 10px;
      margin-top: 10px;
      align-items: stretch;
      animation: deck-in .4s .15s ease-out both;
    }

    .token-panel,
    .diagnostics {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow);
    }

    .diagnostics {
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .token-panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(90deg, rgba(212, 146, 42, .06), transparent 38%),
        linear-gradient(180deg, rgba(255, 255, 255, .02), transparent);
    }

    .token-panel-head .eyebrow {
      margin-bottom: 6px;
      font-size: 9px;
    }

    .token-panel-head h2 {
      margin: 0;
      font: 650 16px/1.2 var(--font-display);
    }

    .token-panel-head p {
      max-width: 760px;
      margin: 4px 0 0;
      color: var(--text-2);
      font-size: 11px;
      line-height: 1.4;
    }

    .token-path {
      flex: 0 0 auto;
      border: 1px solid var(--line);
      border-radius: 3px;
      background: var(--surface-deep);
      padding: 6px 8px;
      color: var(--text-2);
      font: 10px/1 var(--font-mono);
    }

    .token-form { padding: 11px 12px 12px; }

    .token-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .token-field {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: rgba(8, 9, 11, .45);
      padding: 10px;
      transition: border-color .15s ease, background .15s ease;
    }

    .token-field:focus-within {
      border-color: rgba(212, 146, 42, .4);
      background: rgba(11, 13, 16, .7);
    }

    .token-label-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 7px;
    }

    .token-label-row label {
      font: 650 12px/1 var(--font-display);
    }

    .token-status {
      color: var(--text-2);
      font: 9px/1.3 var(--font-mono);
      white-space: nowrap;
    }

    .token-status.configured { color: var(--green-bright); }
    .token-status.inherited { color: var(--amber-bright); }

    .token-input-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 5px;
    }

    .token-input {
      width: 100%;
      min-width: 0;
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 3px;
      outline: 0;
      background: var(--surface-deep);
      color: var(--text);
      padding: 0 9px;
      font: 10px/1 var(--font-mono);
      transition: border-color .15s ease, box-shadow .15s ease;
    }

    .token-input::placeholder { color: var(--faint); }

    .token-input:focus {
      border-color: var(--amber);
      box-shadow: 0 0 0 2px rgba(212, 146, 42, .13);
    }

    .token-field .button {
      min-height: 34px;
      padding-inline: 9px;
      font-size: 10px;
    }

    .token-help {
      margin: 7px 0 0;
      color: var(--text-2);
      font-size: 9px;
      line-height: 1.4;
    }

    .token-help code {
      color: #C9D4DB;
      font-family: var(--font-mono);
    }

    .token-share {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 7px;
      color: var(--text-2);
      font-size: 10px;
      cursor: pointer;
    }

    .token-share input {
      width: 14px;
      height: 14px;
      accent-color: var(--amber);
    }

    .token-form-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-top: 9px;
    }

    .token-form-footer p {
      margin: 0;
      color: var(--text-2);
      font-size: 9px;
      line-height: 1.4;
    }

    .token-form-footer .button { flex: 0 0 auto; }

    .panel-section {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }

    .panel-section:last-child { border-bottom: 0; }

    .panel-title {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 10px;
      color: var(--text-2);
      font: 700 9px/1 var(--font-display);
      letter-spacing: .15em;
      text-transform: uppercase;
    }

    .panel-title::before {
      content: "";
      width: 12px;
      height: 3px;
      border-radius: 1px;
      background: var(--amber);
    }

    .kv {
      display: grid;
      grid-template-columns: 82px minmax(0, 1fr);
      gap: 6px 8px;
    }

    .kv span {
      color: var(--text-2);
      font-size: 9px;
      letter-spacing: .03em;
    }

    .kv strong {
      min-width: 0;
      color: #D5DEE4;
      font: 550 9px/1.35 var(--font-mono);
      overflow-wrap: anywhere;
    }

    /* ---- Output monitor --------------------------------------------------- */
    .monitor {
      position: relative;
      margin-top: 12px;
      overflow: hidden;
      border: 1px solid var(--line-light);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow);
      animation: deck-in .4s .2s ease-out both;
    }

    .monitor::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      z-index: 2;
      height: 2px;
      background: linear-gradient(90deg, var(--amber) 0%, rgba(212, 146, 42, .25) 45%, transparent 75%, rgba(72, 144, 194, .4) 100%);
      pointer-events: none;
    }

    .monitor-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 16px;
      padding: 11px 14px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(90deg, rgba(212, 146, 42, .05), transparent 40%),
        linear-gradient(180deg, rgba(255, 255, 255, .02), transparent);
    }

    .monitor-id {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .tally-light {
      flex: 0 0 auto;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #3A2225;
      box-shadow: inset 0 0 3px rgba(0, 0, 0, .8);
      transition: background .2s ease, box-shadow .2s ease;
    }

    .tally-light.is-live {
      background: var(--red);
      box-shadow: 0 0 9px rgba(212, 82, 82, .7), 0 0 0 2px rgba(212, 82, 82, .2);
      animation: tally-pulse 1.7s ease-in-out infinite;
    }

    .monitor-title {
      margin: 0;
      font: 650 12px/1 var(--font-display);
      letter-spacing: .16em;
      text-transform: uppercase;
    }

    .live-state {
      min-width: 62px;
      height: 23px;
      border: 1px solid var(--line);
      border-radius: 3px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--text-2);
      padding: 0 8px;
      font: 700 8.5px/1 var(--font-display);
      letter-spacing: .1em;
      text-transform: uppercase;
    }

    .live-state-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
    }

    .live-state.live { color: var(--green-bright); }
    .live-state.syncing { color: var(--blue-bright); }
    .live-state.paused { color: var(--amber-bright); }
    .live-state.error { color: var(--red-bright); }

    .live-state.live .live-state-dot {
      animation: signal-pulse 2.4s ease-in-out infinite;
    }

    .channel-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-inline: auto;
    }

    .channel-tab {
      height: 32px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--surface-raised);
      color: var(--text-2);
      padding: 0 13px;
      cursor: pointer;
      font: 600 10px/1 var(--font-display);
      letter-spacing: .1em;
      text-transform: uppercase;
      transition: border-color .15s ease, background .15s ease, color .15s ease, box-shadow .15s ease;
    }

    .tab-led {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--faint);
      opacity: .55;
      transition: background .2s ease, box-shadow .2s ease, opacity .2s ease;
    }

    .channel-tab.is-online .tab-led {
      background: var(--green);
      opacity: 1;
      box-shadow: 0 0 5px rgba(61, 168, 122, .55);
    }

    .channel-tab:hover {
      border-color: var(--line-light);
      background: var(--surface-overlay);
      color: var(--text);
    }

    .channel-tab.active {
      border-color: rgba(212, 146, 42, .55);
      background: rgba(212, 146, 42, .12);
      color: #F4E7CD;
      box-shadow: inset 0 -2px 0 var(--amber);
    }

    .channel-tab:disabled { opacity: .5; cursor: wait; }

    .monitor-controls {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-left: auto;
    }

    .rate-switch {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 3px;
      background: var(--surface-deep);
    }

    .monitor-controls .button {
      min-height: 28px;
      padding-inline: 10px;
      font-size: 9.5px;
      letter-spacing: .05em;
    }

    .rate-switch .button {
      min-height: 24px;
      border-color: transparent;
      background: transparent;
      color: var(--text-2);
    }

    .rate-switch .button.active {
      border-color: rgba(212, 146, 42, .5);
      background: rgba(212, 146, 42, .14);
      color: #F2E3C8;
    }

    .monitor-screen {
      position: relative;
      background: var(--surface-deep);
    }

    /* Scanlines + vignette — the "monitor glass" */
    .monitor-screen::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
      background:
        repeating-linear-gradient(0deg, rgba(226, 232, 238, .015) 0 1px, transparent 1px 3px),
        radial-gradient(130% 100% at 50% 0%, transparent 62%, rgba(0, 0, 0, .34));
    }

    .log {
      position: relative;
      z-index: auto;
      height: 400px;
      margin: 0;
      overflow: auto;
      padding: 2px 0 16px;
      font: 12.5px/1.7 var(--font-mono);
      scrollbar-color: var(--surface-overlay) var(--surface-deep);
    }

    .log::-webkit-scrollbar { width: 10px; height: 10px; }
    .log::-webkit-scrollbar-track { background: transparent; }
    .log::-webkit-scrollbar-thumb {
      background: var(--surface-overlay);
      border-radius: 5px;
      border: 2px solid var(--surface-deep);
    }

    .stream-gutter {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 6px;
      padding: 10px 18px 5px;
      border-top: 1px dashed rgba(83, 96, 112, .4);
      font: 700 9px/1 var(--font-display);
      letter-spacing: .18em;
      text-transform: uppercase;
    }

    .stream:first-of-type .stream-gutter { border-top: 0; margin-top: 0; }

    .stream-gutter::before {
      content: "";
      width: 16px;
      height: 3px;
      border-radius: 1px;
      background: currentColor;
    }

    .stream-stdout .stream-gutter { color: var(--green-bright); }
    .stream-stderr .stream-gutter { color: var(--red-bright); }

    .stream-name { flex: 0 0 auto; }

    .stream-file {
      color: var(--faint);
      font: 9px/1 var(--font-mono);
      letter-spacing: .04em;
      text-transform: lowercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stream-body {
      margin: 0;
      padding: 2px 18px 12px;
      font: inherit;
    }

    .stream-line {
      display: block;
      color: #A9B9C4;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .stream-stderr .stream-line { color: #C09599; }

    .stream-line.line-warn {
      color: var(--amber-bright);
      box-shadow: inset 2px 0 0 var(--amber);
      padding-left: 6px;
    }

    .stream-line.line-err {
      color: var(--red-bright);
      font-weight: 600;
      background: rgba(212, 82, 82, .09);
      box-shadow: inset 2px 0 0 var(--red);
      padding-left: 6px;
    }

    .log-empty {
      height: 100%;
      min-height: 300px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 30px;
      text-align: center;
    }

    .log-empty::before {
      content: "";
      width: 76px;
      height: 7px;
      border-radius: 2px;
      margin-bottom: 12px;
      background: linear-gradient(90deg,
        #b4b4b4 0 14.28%, #b4b44b 0 28.57%, #4bb4b4 0 42.85%,
        #4bb44b 0 57.14%, #b44bb4 0 71.42%, #b44b4b 0 85.71%, #4b4bb4 0 100%);
      opacity: .45;
    }

    .log-empty.is-busy::before { animation: signal-breathe 1.4s ease-in-out infinite; }

    .log-empty p {
      margin: 0;
      color: var(--text-2);
      font: 500 12.5px/1.5 var(--font-display);
      letter-spacing: .04em;
    }

    .log-empty .log-empty-sub {
      color: var(--faint);
      font-size: 10px;
    }

    .monitor-foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      padding: 9px 14px 10px;
      border-top: 1px solid var(--line);
      background: var(--surface);
    }

    .follow-pill {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 20px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 9px;
      color: var(--faint);
      font: 700 8.5px/1 var(--font-display);
      letter-spacing: .11em;
      text-transform: uppercase;
    }

    .follow-pill::before {
      content: "";
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
    }

    .follow-pill.on {
      color: var(--green-bright);
      border-color: rgba(61, 168, 122, .4);
    }

    .output-meta {
      margin: 0;
      min-height: 14px;
      color: var(--text-2);
      font: 9.5px/1.4 var(--font-mono);
      overflow-wrap: anywhere;
    }

    .action-readout {
      margin: 0 0 0 auto;
      max-width: 46%;
      color: var(--amber-bright);
      font: 9.5px/1.4 var(--font-mono);
      text-align: right;
      overflow-wrap: anywhere;
    }

    .action-readout:empty { display: none; }

    .action-readout.error { color: var(--red-bright); }

    .log-paths {
      flex-basis: 100%;
      margin: 0;
      padding-top: 7px;
      border-top: 1px dashed var(--line);
      color: var(--faint);
      font: 9px/1.4 var(--font-mono);
      overflow-wrap: anywhere;
    }

    .log-paths:empty { display: none; }

    /* ---- Toast ------------------------------------------------------------ */
    .toast {
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 60;
      max-width: min(460px, calc(100vw - 36px));
      border: 1px solid var(--line-light);
      border-left: 3px solid var(--amber);
      border-radius: 4px;
      background: var(--surface-raised);
      box-shadow: var(--shadow);
      padding: 11px 13px;
      color: var(--text);
      font-size: 11px;
      line-height: 1.45;
      transform: translateY(12px);
      opacity: 0;
      pointer-events: none;
      transition: transform .18s ease, opacity .18s ease;
      overflow-wrap: anywhere;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    /* ---- Motion ------------------------------------------------------------ */
    @keyframes deck-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes signal-pulse {
      0%, 100% { box-shadow: 0 0 0 2px rgba(61, 168, 122, .15); }
      50% { box-shadow: 0 0 0 4px rgba(61, 168, 122, .05), 0 0 8px rgba(61, 168, 122, .3); }
    }

    @keyframes tally-pulse {
      0%, 100% { box-shadow: 0 0 9px rgba(212, 82, 82, .7), 0 0 0 2px rgba(212, 82, 82, .2); }
      50% { box-shadow: 0 0 3px rgba(212, 82, 82, .4), 0 0 0 2px rgba(212, 82, 82, .12); }
    }

    @keyframes vu {
      0%, 100% { transform: scaleY(.42); }
      50% { transform: scaleY(1); }
    }

    @keyframes signal-breathe {
      0%, 100% { opacity: .2; }
      50% { opacity: .6; }
    }

    @keyframes card-flash {
      0% {
        border-color: var(--amber);
        box-shadow: 0 0 0 1px var(--amber), 0 0 26px rgba(212, 146, 42, .3);
      }
      100% {
        border-color: var(--line);
        box-shadow: 0 0 0 0 transparent;
      }
    }

    /* ---- Responsive -------------------------------------------------------- */
    @media (max-width: 1460px) {
      .service-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .bench { grid-template-columns: 1fr; }
      .diagnostics { grid-template-rows: none; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .panel-section:last-child { border-bottom: 0; }
      .masthead { grid-template-columns: minmax(0, 1fr) auto; }
      .command-deck { grid-column: 2; grid-row: 1; }
      .tally { grid-column: 1 / -1; grid-row: 2; justify-self: start; }
      .masthead::after { display: none; }
    }

    @media (max-width: 980px) {
      .status-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .monitor-head { align-items: flex-start; }
      .channel-tabs {
        order: 3;
        flex-basis: 100%;
        margin-inline: 0;
        flex-wrap: nowrap;
        overflow-x: auto;
        padding-bottom: 2px;
      }
      .channel-tab { flex: 1 0 auto; justify-content: center; }
      .log { height: 320px; }
      .action-readout { max-width: 100%; margin-left: 0; flex-basis: 100%; order: 5; text-align: left; }
    }

    @media (max-width: 760px) {
      main { width: min(100% - 18px, 1560px); padding-top: 14px; }
      .masthead { grid-template-columns: 1fr; gap: 14px; }
      .command-deck { grid-column: auto; grid-row: auto; justify-items: start; }
      .command-label { display: none; }
      .toolbar { width: 100%; justify-content: flex-start; }
      .diagnostics { grid-template-columns: 1fr; }
      .panel-section { border-bottom: 1px solid var(--line); }
      .panel-section:last-child { border-bottom: 0; }
      .token-grid { grid-template-columns: 1fr; }
      .token-panel-head { display: block; }
      .token-path { display: inline-block; margin-top: 8px; }
    }

    @media (max-width: 620px) {
      .service-grid { grid-template-columns: 1fr; }
      .card-head { min-height: auto; }
      .toolbar { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .toolbar .button { width: 100%; }
      .token-input-row { grid-template-columns: minmax(0, 1fr) auto; }
      .token-input-row .button[data-token-toggle] { grid-column: 1 / -1; }
      .token-form-footer { align-items: stretch; flex-direction: column; }
      .token-form-footer .button { width: 100%; }
      .brand-mark { display: none; }
      .log { height: 260px; font-size: 11.5px; }
      .stream-gutter, .stream-body { padding-inline: 12px; }
      .monitor-foot { gap: 6px 12px; }
    }

    @media (max-width: 500px) {
      .status-strip { grid-template-columns: 1fr; }
      .status-tile { min-height: 60px; }
      .monitor-controls { width: 100%; justify-content: space-between; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: .01ms !important;
      }
    }
  </style>
</head>
<body>
  <main id="managerApp" aria-busy="false">
    <header class="masthead">
      <div class="identity">
        <div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="identity-copy">
          <p class="eyebrow">Master Control<span class="eyebrow-tag">MMVB · Reference Room</span></p>
          <h1>Service Manager</h1>
          <p class="subhead">Live process control, diagnostics, and publishing credentials for the local media stack.</p>
        </div>
      </div>
      <div class="tally" id="tally" aria-label="Service tally — select to locate a card"></div>
      <div class="command-deck">
        <p class="command-label">Stack commands</p>
        <div class="toolbar" role="group" aria-label="Full stack controls">
          <button class="button primary" type="button" data-stack="start-all">Start All</button>
          <button class="button warn" type="button" data-stack="restart-all">Restart All</button>
          <button class="button danger" type="button" data-stack="stop-all">Stop All</button>
          <button class="button" type="button" id="refreshButton">Refresh</button>
        </div>
      </div>
    </header>

    <section class="status-strip" id="summary" aria-label="Stack status overview"></section>

    <section class="service-grid" id="cards" aria-label="Managed services"></section>

    <section class="bench" aria-label="Credentials and diagnostics">
      <section class="token-panel" aria-labelledby="uploadTokensTitle">
        <div class="token-panel-head">
          <div>
            <p class="eyebrow">Credentials</p>
            <h2 id="uploadTokensTitle">Upload tokens</h2>
            <p>Manage browser publishing credentials in one place. Existing values stay hidden; each save restarts the Upload API so changes take effect immediately.</p>
          </div>
          <span class="token-path" id="tokenPath">apps/api/.env</span>
        </div>
        <form class="token-form" id="tokenForm">
          <div class="token-grid">
            <div class="token-field">
              <div class="token-label-row">
                <label for="uploadToken">Video &amp; albums</label>
                <span class="token-status" id="uploadTokenStatus">Checking...</span>
              </div>
              <div class="token-input-row">
                <input class="token-input" id="uploadToken" name="uploadToken" type="password" autocomplete="new-password" spellcheck="false" minlength="24" maxlength="256" placeholder="Leave blank to keep current" aria-describedby="uploadTokenHelp" />
                <button class="button" type="button" data-token-generate="uploadToken">Generate</button>
                <button class="button" type="button" data-token-toggle="uploadToken" aria-label="Show video and album token">Show</button>
              </div>
              <p class="token-help" id="uploadTokenHelp"><code>UPLOAD_API_TOKEN</code> protects video uploads, albums, photos, and film-scan jobs.</p>
            </div>

            <div class="token-field">
              <div class="token-label-row">
                <label for="articleToken">Articles</label>
                <span class="token-status" id="articleTokenStatus">Checking...</span>
              </div>
              <div class="token-input-row">
                <input class="token-input" id="articleToken" name="articleToken" type="password" autocomplete="new-password" spellcheck="false" minlength="24" maxlength="256" placeholder="Leave blank to keep current" aria-describedby="articleTokenHelp" />
                <button class="button" type="button" data-token-generate="articleToken">Generate</button>
                <button class="button" type="button" data-token-toggle="articleToken" aria-label="Show article token">Show</button>
              </div>
              <label class="token-share" for="articleUsesUploadToken">
                <input id="articleUsesUploadToken" name="articleUsesUploadToken" type="checkbox" />
                Use the video &amp; album token for articles
              </label>
              <p class="token-help" id="articleTokenHelp"><code>ARTICLE_API_TOKEN</code> protects the article editor and can intentionally share the primary token.</p>
            </div>
          </div>
          <div class="token-form-footer">
            <p>Stored token text is never returned to this page. The short code beside each status is a one-way fingerprint for identifying the active credential.</p>
            <button class="button primary" type="submit" id="saveTokensButton">Save tokens &amp; restart API</button>
          </div>
        </form>
      </section>

      <aside class="diagnostics" aria-label="System diagnostics">
        <section class="panel-section">
          <h2 class="panel-title">Manager</h2>
          <div class="kv" id="managerMeta"></div>
        </section>
        <section class="panel-section">
          <h2 class="panel-title">Database</h2>
          <div class="kv" id="databaseMeta"></div>
        </section>
      </aside>
    </section>

    <section class="monitor" id="outputMonitor" aria-label="Live output monitor">
      <header class="monitor-head">
        <div class="monitor-id">
          <span class="tally-light" id="tallyLight" aria-hidden="true"></span>
          <h2 class="monitor-title">Output Monitor</h2>
          <span class="live-state" id="liveLogState"><span class="live-state-dot" aria-hidden="true"></span><span id="liveLogStateText">Idle</span></span>
        </div>
        <div class="channel-tabs" role="group" aria-label="Live output source">
          <button class="channel-tab" type="button" data-log="web" aria-pressed="false"><i class="tab-led" aria-hidden="true"></i>Web</button>
          <button class="channel-tab" type="button" data-log="api" aria-pressed="false"><i class="tab-led" aria-hidden="true"></i>API</button>
          <button class="channel-tab" type="button" data-log="cms" aria-pressed="false"><i class="tab-led" aria-hidden="true"></i>CMS</button>
          <button class="channel-tab" type="button" data-log="manager" aria-pressed="false"><i class="tab-led" aria-hidden="true"></i>Manager</button>
        </div>
        <div class="monitor-controls">
          <div class="rate-switch" role="group" aria-label="Live output refresh interval">
            <button class="button active" type="button" data-log-interval="3000" aria-pressed="true">3s</button>
            <button class="button" type="button" data-log-interval="10000" aria-pressed="false">10s</button>
          </div>
          <button class="button" type="button" id="toggleLogPolling" aria-pressed="false">Pause</button>
        </div>
      </header>
      <div class="monitor-screen">
        <div class="log" id="log" role="region" aria-label="Live service output" aria-live="off" tabindex="0">
          <div class="log-empty is-busy"><p>Acquiring Web channel</p><p class="log-empty-sub">Connecting to the live output buffer...</p></div>
        </div>
      </div>
      <footer class="monitor-foot">
        <span class="follow-pill on" id="followPill" title="Auto-scrolling to newest output">Follow</span>
        <p class="output-meta" id="liveLogMeta" role="status" aria-live="polite">Waiting for a log source.</p>
        <p class="action-readout" id="actionReadout" role="status" aria-live="polite"></p>
        <p class="log-paths" id="logPaths"></p>
      </footer>
    </section>
  </main>
  <div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>

  <script>
    const API_BASE = ${JSON.stringify(MANAGER_BASE_PATH)};
    const AUTO_REFRESH_INTERVAL_MS = 2000;
    const LOG_SOURCE_LABELS = Object.freeze({
      web: "Web",
      api: "Upload API",
      cms: "Directus CMS",
      manager: "Service Manager"
    });
    const LOG_SOURCE_SHORT = Object.freeze({
      postgres: "PG",
      cms: "CMS",
      api: "API",
      web: "WEB"
    });
    const ERROR_PATTERN = /error|fail|exception|fatal|unhandled|refused|traceback|panic|cannot find/i;
    const WARN_PATTERN = /warn|deprecat|retry|slow|pending/i;

    const managerApp = document.getElementById("managerApp");
    const summary = document.getElementById("summary");
    const tally = document.getElementById("tally");
    const cards = document.getElementById("cards");
    const managerMeta = document.getElementById("managerMeta");
    const databaseMeta = document.getElementById("databaseMeta");
    const outputMonitor = document.getElementById("outputMonitor");
    const tallyLight = document.getElementById("tallyLight");
    const liveLogState = document.getElementById("liveLogState");
    const liveLogStateText = document.getElementById("liveLogStateText");
    const liveLogMeta = document.getElementById("liveLogMeta");
    const actionReadout = document.getElementById("actionReadout");
    const logPaths = document.getElementById("logPaths");
    const followPill = document.getElementById("followPill");
    const log = document.getElementById("log");
    const toggleLogPolling = document.getElementById("toggleLogPolling");
    const toast = document.getElementById("toast");
    const refreshButton = document.getElementById("refreshButton");
    const tokenForm = document.getElementById("tokenForm");
    const tokenPath = document.getElementById("tokenPath");
    const uploadToken = document.getElementById("uploadToken");
    const articleToken = document.getElementById("articleToken");
    const articleUsesUploadToken = document.getElementById("articleUsesUploadToken");

    let state = null;
    let busy = false;
    let tokenFormDirty = false;
    let toastTimer = null;
    let readoutTimer = null;
    let refreshPromise = null;
    let statusRefreshing = false;
    let activeLogService = "web";
    let logPollingEnabled = true;
    let logPollIntervalMs = 3000;
    let logPollTimer = null;
    let logRequestController = null;
    let logRequestInFlight = false;
    let lastLogSignature = null;
    let lastLogError = null;
    let lastLogUpdatedAt = null;

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
      managerApp.setAttribute("aria-busy", String(nextBusy));
      document.querySelectorAll("button, input, select").forEach((control) => {
        control.disabled = nextBusy;
      });
      syncArticleTokenInput();
      if (nextBusy) {
        clearTimeout(logPollTimer);
        logRequestController?.abort();
      } else {
        scheduleLogPoll(logPollIntervalMs);
      }
      updateLogControls();
    }

    function syncArticleTokenInput() {
      const disabled = busy || articleUsesUploadToken.checked;
      articleToken.disabled = disabled;
      document.querySelectorAll('[data-token-generate="articleToken"], [data-token-toggle="articleToken"]').forEach((button) => {
        button.disabled = disabled;
      });
    }

    function notify(message) {
      clearTimeout(toastTimer);
      toast.textContent = message;
      toast.classList.add("show");
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
    }

    function setActionReadout(text, tone) {
      clearTimeout(readoutTimer);
      actionReadout.textContent = text || "";
      actionReadout.className = "action-readout" + (tone ? " " + tone : "");
      if (text) {
        readoutTimer = setTimeout(() => {
          actionReadout.textContent = "";
          actionReadout.className = "action-readout";
        }, 12000);
      }
    }

    function apiPath(path) {
      return API_BASE + path;
    }

    function serviceState(item) {
      if (item.healthy) return { label: "Healthy", cls: "ok" };
      if (item.running) return { label: "Degraded", cls: "warn" };
      return { label: "Stopped", cls: "off" };
    }

    function badge(item) {
      const status = serviceState(item);
      return '<span class="badge ' + status.cls + '" aria-label="Status: ' + esc(status.label) + '"><span class="dot" aria-hidden="true"></span>' + status.label + '</span>';
    }

    function metric(label, value) {
      return '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
    }

    function serviceCard(item, index) {
      const status = serviceState(item);
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
        ? '<a class="button" href="' + esc(item.openUrl) + '" target="_blank" rel="noreferrer" aria-label="Open ' + esc(item.name) + '">Open</a>'
        : "";
      const logs = item.logName
        ? '<button class="button" type="button" data-log="' + esc(item.id) + '" aria-label="Watch ' + esc(item.name) + ' in the output monitor">Logs</button>'
        : "";
      const rebuild = item.id === "web"
        ? '<button class="button" type="button" data-action="rebuild-restart" data-id="' + esc(item.id) + '" aria-label="Build and restart ' + esc(item.name) + '">Build + Restart</button>'
        : "";
      const webMode = item.id === "web"
        ? '<div class="mode-switch" role="group" aria-label="Frontend Web mode">'
          + '<button class="button ' + (item.mode === "development" ? "active" : "") + '" type="button" data-web-mode="development" aria-pressed="' + (item.mode === "development") + '">Development</button>'
          + '<button class="button ' + (item.mode === "production" ? "active" : "") + '" type="button" data-web-mode="production" aria-pressed="' + (item.mode === "production") + '">Production</button>'
          + '</div>'
        : "";

      return '<article class="service-card ' + status.cls + '" data-card="' + esc(item.id) + '" aria-labelledby="service-' + esc(item.id) + '-title">'
        + '<header class="card-head">'
        + '<div class="card-id"><span class="card-index" aria-hidden="true">' + String(index + 1).padStart(2, "0") + '</span>'
        + '<div class="card-title"><h2 id="service-' + esc(item.id) + '-title">' + esc(item.name) + '</h2>'
        + '<p class="card-meta">' + esc(item.category) + " · " + esc(meta) + '</p></div></div>'
        + badge(item)
        + '</header>'
        + '<div class="metrics">' + metrics + '</div>'
        + '<footer class="card-actions">'
        + webMode
        + '<button class="button primary" type="button" data-action="start" data-id="' + esc(item.id) + '" aria-label="Start ' + esc(item.name) + '">Start</button>'
        + '<button class="button warn" type="button" data-action="restart" data-id="' + esc(item.id) + '" aria-label="Restart ' + esc(item.name) + '">Restart</button>'
        + rebuild
        + '<button class="button danger" type="button" data-action="stop" data-id="' + esc(item.id) + '" aria-label="Stop ' + esc(item.name) + '">Stop</button>'
        + open
        + logs
        + '</footer>'
        + '</article>';
    }

    function kv(data) {
      return Object.entries(data).map(([key, value]) =>
        '<span>' + esc(key) + '</span><strong>' + esc(value) + '</strong>'
      ).join("");
    }

    function renderTally(data) {
      tally.innerHTML = data.services.map((item) => {
        const status = serviceState(item);
        return '<button class="tally-chip ' + status.cls + '" type="button" data-jump="' + esc(item.id) + '" title="' + esc(item.name) + ' — ' + esc(status.label) + '">'
          + '<i aria-hidden="true"></i><span>' + esc(LOG_SOURCE_SHORT[item.id] || item.id) + '</span></button>';
      }).join("");
    }

    function jumpToService(id) {
      const card = cards.querySelector('[data-card="' + id + '"]');
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.remove("flash");
      requestAnimationFrame(() => card.classList.add("flash"));
      setTimeout(() => card.classList.remove("flash"), 1400);
    }

    function renderUploadTokens(config) {
      if (!config) return;
      tokenPath.textContent = config.path;
      const upload = config.tokens.find((item) => item.id === "upload");
      const article = config.tokens.find((item) => item.id === "article");

      for (const item of [upload, article]) {
        if (!item) continue;
        const element = document.getElementById(item.id + "TokenStatus");
        element.textContent = item.configured
          ? (item.inherited ? "Shared · " : "Active · ") + item.masked
          : "Not configured";
        element.className = "token-status"
          + (item.configured ? " configured" : "")
          + (item.inherited ? " inherited" : "");
      }

      if (!tokenFormDirty && article) {
        articleUsesUploadToken.checked = article.inherited;
        syncArticleTokenInput();
      }
    }

    function render(data) {
      state = data;
      const running = data.services.filter((item) => item.running).length;
      const healthy = data.services.filter((item) => item.healthy).length;
      const stopped = data.services.length - running;
      summary.innerHTML = [
        summaryItem("Running", running + " / " + data.services.length, "info"),
        summaryItem("Healthy", healthy + " / " + data.services.length, "ok"),
        summaryItem("Stopped", stopped, stopped > 0 ? "alert" : "neutral"),
        summaryItem("Last sync", new Date(data.updatedAt).toLocaleTimeString(), "neutral")
      ].join("");
      document.title = healthy + "/" + data.services.length + " healthy · Service Manager";

      renderTally(data);
      cards.innerHTML = data.services.map(serviceCard).join("");
      updateLogControls();
      renderUploadTokens(data.uploadTokens);
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

    function summaryItem(label, value, tone) {
      return '<div class="status-tile ' + esc(tone) + '"><span class="tile-label">' + esc(label) + '</span><strong class="tile-value" title="' + esc(value) + '">' + esc(value) + '</strong></div>';
    }

    function refresh(silent = false) {
      if (refreshPromise) return refreshPromise;
      if (!silent) {
        statusRefreshing = true;
        updateLogControls();
      }
      refreshPromise = (async () => {
        try {
          const response = await fetch(apiPath("/api/status"), { cache: "no-store" });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Status request failed");
          render(data);
        } catch (error) {
          if (!silent) {
            setActionReadout("Status refresh failed: " + error.message, "error");
            notify(error.message);
          }
        } finally {
          refreshPromise = null;
          if (statusRefreshing) {
            statusRefreshing = false;
            updateLogControls();
          }
        }
      })();
      return refreshPromise;
    }

    async function runServiceAction(id, action) {
      if (busy) return;
      setBusy(true);
      setActionReadout("Running " + action + " on " + id + "...");
      try {
        const response = await fetch(apiPath("/api/services/" + encodeURIComponent(id) + "/" + encodeURIComponent(action)), {
          method: "POST"
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Action failed");
        render(data.status);
        const message = data.result.message || "Done.";
        setActionReadout(message);
        notify(message);
      } catch (error) {
        setActionReadout("Error: " + error.message, "error");
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
      setActionReadout("Running " + action + "...");
      try {
        const response = await fetch(apiPath("/api/stack/" + encodeURIComponent(action)), { method: "POST" });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.error || "Stack action failed");
        }
        render(data.status);
        setActionReadout((data.result.results || [])
          .map((item) => item.serviceId + ": " + item.message)
          .join(" · "));
        notify(data.result.message || "Done.");
      } catch (error) {
        setActionReadout("Error: " + error.message, "error");
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
      setActionReadout("Switching Frontend Web to " + nextLabel + " mode...");
      try {
        const response = await fetch(apiPath("/api/services/web/mode/" + encodeURIComponent(mode)), {
          method: "POST"
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Mode switch failed");
        render(data.status);
        const message = data.result.message || "Frontend Web mode switched.";
        setActionReadout(message);
        notify(message);
      } catch (error) {
        setActionReadout("Error: " + error.message, "error");
        notify(error.message);
        await refresh(true).catch(() => {});
      } finally {
        setBusy(false);
      }
    }

    async function saveUploadTokens() {
      if (busy) return;
      if (!tokenForm.checkValidity()) {
        tokenForm.reportValidity();
        return;
      }

      const payload = {
        uploadToken: uploadToken.value.trim(),
        articleToken: articleUsesUploadToken.checked ? "" : articleToken.value.trim(),
        articleUsesUploadToken: articleUsesUploadToken.checked
      };
      const currentArticle = state?.uploadTokens?.tokens?.find((item) => item.id === "article");
      const sharingChanged = Boolean(currentArticle?.inherited) !== payload.articleUsesUploadToken;
      if (!payload.uploadToken && !payload.articleToken && !sharingChanged) {
        notify("Enter a new token or change the article sharing option.");
        return;
      }

      setBusy(true);
      setActionReadout("Saving upload tokens and restarting the Upload API...");
      try {
        const response = await fetch(apiPath("/api/upload-tokens"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Token update failed");

        uploadToken.value = "";
        articleToken.value = "";
        uploadToken.type = "password";
        articleToken.type = "password";
        document.querySelectorAll("[data-token-toggle]").forEach((button) => {
          button.textContent = "Show";
        });
        tokenFormDirty = false;
        render(data.status);
        const message = data.result.message || "Upload tokens updated.";
        setActionReadout(message);
        notify(message);
      } catch (error) {
        setActionReadout("Error: " + error.message, "error");
        notify(error.message);
        await refresh(true).catch(() => {});
      } finally {
        setBusy(false);
      }
    }

    function generateToken(inputId) {
      const input = document.getElementById(inputId);
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      input.value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      input.type = "text";
      tokenFormDirty = true;
      const toggle = document.querySelector('[data-token-toggle="' + inputId + '"]');
      if (toggle) toggle.textContent = "Hide";
      input.focus();
      input.select();
    }

    function toggleToken(inputId, button) {
      const input = document.getElementById(inputId);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.textContent = show ? "Hide" : "Show";
      button.setAttribute("aria-label", (show ? "Hide " : "Show ") + inputId.replace(/([A-Z])/g, " $1").toLowerCase());
    }

    function logSourceLabel(id = activeLogService) {
      return LOG_SOURCE_LABELS[id] || id || "No source";
    }

    function isNearBottom() {
      return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    }

    function followBottom() {
      log.scrollTop = log.scrollHeight;
      updateFollowPill();
    }

    function updateFollowPill() {
      const on = isNearBottom();
      followPill.classList.toggle("on", on);
      followPill.textContent = on ? "Follow" : "Manual";
      followPill.title = on
        ? "Auto-scrolling to newest output"
        : "Auto-scroll paused — scroll back to the bottom to resume";
    }

    function updateLogControls() {
      const hasSource = Boolean(LOG_SOURCE_LABELS[activeLogService]);
      document.querySelectorAll("[data-log]").forEach((button) => {
        const active = button.dataset.log === activeLogService;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
        const service = button.dataset.log === "manager"
          ? { running: true }
          : state?.services?.find((item) => item.id === button.dataset.log);
        button.classList.toggle("is-online", Boolean(service && service.running));
      });
      document.querySelectorAll("[data-log-interval]").forEach((button) => {
        const active = Number(button.dataset.logInterval) === logPollIntervalMs;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
        button.disabled = busy || !hasSource;
      });

      toggleLogPolling.disabled = busy || !hasSource;
      toggleLogPolling.textContent = logPollingEnabled ? "Pause" : "Resume";
      toggleLogPolling.setAttribute("aria-pressed", String(!logPollingEnabled));

      let stateClass = "";
      let stateText = "Idle";
      let metaText = "Waiting for a log source.";
      if (hasSource && busy) {
        stateClass = "paused";
        stateText = "Hold";
        metaText = "Live output holds while a stack command runs.";
      } else if (hasSource && statusRefreshing) {
        stateClass = "syncing";
        stateText = "Sync";
        metaText = "Refreshing stack status...";
      } else if (hasSource && !logPollingEnabled) {
        stateClass = "paused";
        stateText = "Paused";
        metaText = logSourceLabel() + " · polling paused";
      } else if (hasSource && document.visibilityState !== "visible") {
        stateClass = "paused";
        stateText = "Hidden";
        metaText = logSourceLabel() + " · polling waits while this tab is hidden";
      } else if (hasSource && lastLogError) {
        stateClass = "error";
        stateText = "Error";
        metaText = logSourceLabel() + " · " + lastLogError;
      } else if (hasSource && logRequestInFlight) {
        stateClass = "syncing";
        stateText = "Syncing";
        metaText = logSourceLabel() + " · reading output";
      } else if (hasSource) {
        stateClass = "live";
        stateText = "Live";
        metaText = logSourceLabel()
          + (lastLogUpdatedAt ? " · updated " + lastLogUpdatedAt.toLocaleTimeString() : " · waiting for first update")
          + " · every " + (logPollIntervalMs / 1000) + " sec";
      }

      liveLogState.className = "live-state" + (stateClass ? " " + stateClass : "");
      liveLogStateText.textContent = stateText;
      liveLogMeta.textContent = metaText;
      tallyLight.classList.toggle("is-live", stateClass === "live");
      updateFollowPill();
    }

    function showScreenNotice(title, sub) {
      log.replaceChildren();
      const box = document.createElement("div");
      box.className = "log-empty is-busy";
      const head = document.createElement("p");
      head.textContent = title;
      box.append(head);
      if (sub) {
        const note = document.createElement("p");
        note.className = "log-empty-sub";
        note.textContent = sub;
        box.append(note);
      }
      log.append(box);
      logPaths.textContent = "";
    }

    function streamBlock(kind, label, filePath, content) {
      const text = String(content || "").replace(/\r/g, "");
      if (!text.trim()) return null;

      const wrap = document.createElement("section");
      wrap.className = "stream stream-" + kind;

      const gutter = document.createElement("div");
      gutter.className = "stream-gutter";
      const name = document.createElement("span");
      name.className = "stream-name";
      name.textContent = label;
      const file = document.createElement("span");
      file.className = "stream-file";
      file.textContent = filePath;
      gutter.append(name, file);

      const body = document.createElement("pre");
      body.className = "stream-body";
      for (const line of text.split("\n")) {
        const row = document.createElement("span");
        row.className = "stream-line";
        if (ERROR_PATTERN.test(line)) {
          row.classList.add("line-err");
        } else if (kind === "stdout" && WARN_PATTERN.test(line)) {
          row.classList.add("line-warn");
        }
        row.textContent = line.length ? line : " ";
        body.append(row);
      }

      wrap.append(gutter, body);
      return wrap;
    }

    function renderLogStreams(data) {
      log.replaceChildren();
      const streams = [
        streamBlock("stdout", "stdout", data.files.stdout, data.stdout),
        streamBlock("stderr", "stderr", data.files.stderr, data.stderr)
      ].filter(Boolean);

      if (streams.length === 0) {
        const empty = document.createElement("div");
        empty.className = "log-empty";
        empty.innerHTML = "<p>No output recorded for " + esc(logSourceLabel(data.serviceId)) + "</p>"
          + '<p class="log-empty-sub">New lines appear here automatically while polling is live.</p>';
        log.append(empty);
        logPaths.textContent = "";
        return;
      }

      streams.forEach((stream) => log.append(stream));
      logPaths.textContent = data.files.stdout + "   ·   " + data.files.stderr;
    }

    async function loadLogs(id, options = {}) {
      if (busy || !LOG_SOURCE_LABELS[id]) return;
      const sourceChanged = id !== activeLogService;
      if (logRequestInFlight && !sourceChanged) return;

      if (sourceChanged) {
        activeLogService = id;
        lastLogSignature = null;
        lastLogUpdatedAt = null;
        lastLogError = null;
        showScreenNotice("Acquiring " + logSourceLabel(id) + " channel", "Reading the latest buffered output...");
      }

      logRequestController?.abort();
      const controller = new AbortController();
      logRequestController = controller;
      logRequestInFlight = true;
      updateLogControls();

      try {
        const response = await fetch(apiPath("/api/logs/" + encodeURIComponent(id)), {
          cache: "no-store",
          signal: controller.signal
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Log request failed");
        if (controller !== logRequestController) return;

        const signature = data.stdout + "\n---stderr---\n" + data.stderr;
        const follow = sourceChanged || options.forceFollow || isNearBottom();
        if (signature !== lastLogSignature) {
          renderLogStreams(data);
          lastLogSignature = signature;
        }
        if (follow) followBottom();
        lastLogError = null;
        lastLogUpdatedAt = new Date(data.updatedAt || Date.now());
      } catch (error) {
        if (error.name === "AbortError") return;
        lastLogError = "refresh failed: " + error.message;
        if (options.announce) notify(error.message);
      } finally {
        if (controller === logRequestController) {
          logRequestController = null;
          logRequestInFlight = false;
          updateLogControls();
        }
      }
    }

    function scheduleLogPoll(delay = logPollIntervalMs) {
      clearTimeout(logPollTimer);
      if (
        !activeLogService ||
        !logPollingEnabled ||
        document.visibilityState !== "visible"
      ) return;
      logPollTimer = setTimeout(async () => {
        if (!busy && document.visibilityState === "visible") {
          await loadLogs(activeLogService);
        }
        scheduleLogPoll(logPollIntervalMs);
      }, delay);
    }

    async function selectLogSource(id) {
      if (busy || !LOG_SOURCE_LABELS[id]) return;
      const sourceChanged = id !== activeLogService;
      logPollingEnabled = true;
      if (sourceChanged) {
        logRequestController?.abort();
        logRequestController = null;
        logRequestInFlight = false;
        activeLogService = id;
        lastLogSignature = null;
        lastLogUpdatedAt = null;
        lastLogError = null;
        showScreenNotice("Acquiring " + logSourceLabel(id) + " channel", "Reading the latest buffered output...");
      }
      updateLogControls();
      await loadLogs(id, { announce: true, forceFollow: true });
      scheduleLogPoll(logPollIntervalMs);
    }

    function setLogPollInterval(value) {
      const interval = Number(value);
      if (![3000, 10000].includes(interval)) return;
      logPollIntervalMs = interval;
      updateLogControls();
      scheduleLogPoll(logPollIntervalMs);
    }

    async function toggleLiveLogs() {
      if (busy || !activeLogService) return;
      logPollingEnabled = !logPollingEnabled;
      clearTimeout(logPollTimer);
      if (!logPollingEnabled) {
        logRequestController?.abort();
        updateLogControls();
        return;
      }
      updateLogControls();
      await loadLogs(activeLogService, { announce: true });
      scheduleLogPoll(logPollIntervalMs);
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

      const jumpButton = event.target.closest("[data-jump]");
      if (jumpButton) {
        jumpToService(jumpButton.dataset.jump);
        return;
      }

      const logButton = event.target.closest("[data-log]");
      if (logButton) {
        if (!logButton.closest(".monitor")) {
          outputMonitor.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        selectLogSource(logButton.dataset.log);
        return;
      }

      const logIntervalButton = event.target.closest("[data-log-interval]");
      if (logIntervalButton) {
        setLogPollInterval(logIntervalButton.dataset.logInterval);
        return;
      }

      const modeButton = event.target.closest("[data-web-mode]");
      if (modeButton) {
        setWebMode(modeButton.dataset.webMode);
        return;
      }

      const generateButton = event.target.closest("[data-token-generate]");
      if (generateButton) {
        generateToken(generateButton.dataset.tokenGenerate);
        return;
      }

      const toggleButton = event.target.closest("[data-token-toggle]");
      if (toggleButton) {
        toggleToken(toggleButton.dataset.tokenToggle, toggleButton);
      }
    });

    tokenForm.addEventListener("input", () => {
      tokenFormDirty = true;
    });
    articleUsesUploadToken.addEventListener("change", syncArticleTokenInput);
    tokenForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveUploadTokens();
    });
    toggleLogPolling.addEventListener("click", toggleLiveLogs);
    refreshButton.addEventListener("click", () => refresh());
    log.addEventListener("scroll", updateFollowPill, { passive: true });
    refresh();
    selectLogSource(activeLogService).catch((error) => {
      lastLogError = "refresh failed: " + error.message;
      updateLogControls();
    });
    setInterval(() => {
      if (!busy && document.visibilityState === "visible") {
        refresh(true);
      }
    }, AUTO_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!busy && document.visibilityState === "visible") {
        refresh(true);
        if (logPollingEnabled) {
          loadLogs(activeLogService).finally(() => scheduleLogPoll(logPollIntervalMs));
        }
      } else {
        clearTimeout(logPollTimer);
        logRequestController?.abort();
      }
    });
  </script>
</body>
</html>`;
}
