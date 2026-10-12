const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  runPowerShell: executePowerShell,
  stopProcessesCommand
} = require("./manager-powershell.cjs");
const {
  loadDirectusEnv,
  openDirectusDatabase
} = require("./directus-db-utils.cjs");

const ROOT = path.resolve(__dirname, "..");
const ROOT_ENV = loadEnvFile(path.join(ROOT, ".env"));
const HOST = managerEnv("MANAGER_HOST", "127.0.0.1");
const PORT = Number(managerEnv("MANAGER_PORT", 8070));
// Directus cold startup can take over a minute on Windows.
const WAIT_MS = Number(managerEnv("MANAGER_WAIT_MS", 90000));
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
let activeOperation = null;
async function withOperation(label, operation) {
  if (activeOperation) {
    const error = new Error("Another operation is running: " + activeOperation);
    error.statusCode = 409;
    throw error;
  }
  activeOperation = label;
  let release;
  try {
    await fsp.mkdir(path.join(ROOT, "logs"), { recursive: true });
    try {
      release = await require("proper-lockfile").lock(path.join(ROOT, "logs", "service-operation"), {
        realpath: false, retries: 0, stale: 120000, update: 10000
      });
    } catch (error) {
      if (error.code === "ELOCKED") {
        error.statusCode = 409;
        error.message = "Another service operation is running in Manager or a startup script. Retry after it finishes.";
      }
      throw error;
    }
    // A CLI invocation may have changed the persisted mode since Manager started.
    currentWebMode = coerceWebMode(process.env[WEB_MODE_ENV_KEY] || loadEnvFile(path.join(ROOT, ".env"))[WEB_MODE_ENV_KEY] || managerEnv("WEB_MODE", "development"));
    return await operation();
  } finally {
    try { if (release) await release(); }
    finally { activeOperation = null; }
  }
}

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
  return executePowerShell(command, ROOT);
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
  const owners = await getPortOwners(port);
  if (!owners.length) return [];
  const command = [
    `$owners = @(${owners.join(",")});`,
    "$processes = Get-CimInstance Win32_Process;",
    "$byId = @{};",
    "$processes | ForEach-Object { $byId[[int]$_.ProcessId] = $_ };",
    "$protected = @{};",
    `$ancestor = ${process.pid};`,
    "while ($ancestor -and $byId.ContainsKey($ancestor) -and -not $protected.ContainsKey($ancestor)) {",
    "$protected[$ancestor] = $true; $ancestor = [int]$byId[$ancestor].ParentProcessId",
    "};",
    "$rows = @();",
    "foreach ($owner in $owners) {",
    "$current = [int]$owner;",
    "$depth = 0;",
    "while ($current -and $byId.ContainsKey($current)) {",
    "if ($protected.ContainsKey($current)) { break };",
    "$proc = $byId[$current];",
    "$name = [string]$proc.Name;",
    "$allowedAncestor = @('node.exe','cmd.exe') -contains $name.ToLowerInvariant();",
    "if ($depth -gt 0 -and -not $allowedAncestor) { break }",
    "if ($depth -gt 0 -and ([string]$proc.CommandLine -notmatch '(?i)(npm(?:-cli\\.js|\\.cmd)|next|directus)' -or [string]$proc.CommandLine -match '(?i)(manager-dashboard|service-control|start-all-services|start-services)')) { break };",
    "if (-not ($rows | Where-Object { $_.ProcessId -eq $current })) {",
    "$rows += [pscustomobject]@{",
    "ProcessId = [int]$proc.ProcessId;",
    "ParentProcessId = [int]$proc.ParentProcessId;",
    "Name = $proc.Name;",
    "CommandLine = $proc.CommandLine;",
    "Depth = $depth",
    "}",
    "}",
    "$parentId = [int]$proc.ParentProcessId;",
    "if ($byId.ContainsKey($parentId) -and $byId[$parentId].CreationDate -gt $proc.CreationDate) { break };",
    "if ($parentId -eq $current -or ($rows | Where-Object { $_.ProcessId -eq $parentId })) { break };",
    "$current = $parentId;",
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

async function checkHttp(url, timeoutMs = 3000) {
  const started = Date.now();
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
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
    const status = await checkHttp(service.healthUrl, Math.max(1, Math.min(3000, WAIT_MS - (Date.now() - started))));
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
    await waitForProcessHealth(service);
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
    await waitForPortStopped(service);
    return { ok: true, message: `${service.name} is already stopped.` };
  }

  const ids = targets.map((target) => Number(target.ProcessId)).filter(Boolean);
  await runPowerShell(stopProcessesCommand(ids));
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

  if (!/^0$/.test(exitCode)) {
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

  await controlWindowsService(service, "Start-Service");
  await waitForWindowsService(service.serviceName, "Running");
  return { ok: true, message: `Started ${service.name}.` };
}

async function stopWindowsService(service) {
  const state = await getWindowsServiceState(service.serviceName).catch(() => null);
  if (state?.Status === "Stopped") {
    return { ok: true, message: `${service.name} is already stopped.` };
  }

  await controlWindowsService(service, "Stop-Service", " -Force");
  await waitForWindowsService(service.serviceName, "Stopped");
  return { ok: true, message: `Stopped ${service.name}.` };
}

async function controlWindowsService(service, command, options = "") {
  try {
    await runPowerShell(
      command + " -Name " + psQuote(service.serviceName) + options + " -ErrorAction Stop"
    );
  } catch (error) {
    throw new Error(
      command + " failed for " + service.serviceName + ". " +
      "If access is denied, restart the Service Manager from an Administrator PowerShell " +
      "with npm run manager:restart, then retry. " +
      (error.stderr || error.message)
    );
  }
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
    db = await openDirectusDatabase(loadDirectusEnv(), { connectionTimeoutMillis: 3000, query_timeout: 3000, statement_timeout: 3000 });
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
    platform: process.platform,
    activeOperation
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
      await stopProcessService(service);
      if (currentWebMode === "production") await buildWeb();
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
  const previousMode = currentWebMode;
  // Stop before next build: both modes share the .next output directory.
  await stopProcessService(web);
  try {
    if (nextMode === "production") await buildWeb();
    currentWebMode = nextMode;
    await startProcessService(web, { skipBuild: true });
    setRootEnvValue(WEB_MODE_ENV_KEY, nextMode);
    // The persisted selection supersedes the startup override. Future operations
    // read the file so switches from other processes remain visible too.
    delete process.env[WEB_MODE_ENV_KEY];
  } catch (error) {
    currentWebMode = previousMode;
    let recovery = "Previous mode restored and restarted.";
    try {
      await stopProcessService(web);
      await startProcessService(web);
    } catch (recoveryError) {
      recovery = "Previous mode retained, but recovery failed: " + cleanPowerShellError(recoveryError);
    }
    throw new Error("Mode switch failed: " + cleanPowerShellError(error) + ". " + recovery);
  }

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
    let stopError;
    try { await runStackActions(["web", "api", "cms", "postgres"], "stop"); }
    catch (error) { stopError = error; }
    await delay(1000);
    let started;
    try { started = await runStackActions(["postgres", "cms", "api", "web"], "start"); }
    catch (error) {
      if (stopError) {
        error.message = "Stop phase: " + stopError.message + "; startup recovery: " + error.message;
        error.results = [...stopError.results, ...error.results];
      }
      throw error;
    }
    if (stopError) {
      stopError.message = "Restart was incomplete: " + stopError.message + ". Startup recovery completed; services are running.";
      throw stopError;
    }
    return started;
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
      if (action === "start") break;
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
      const result = await withOperation(stackMatch[1], () => handleStackAction(stackMatch[1]));
      sendJson(res, 200, { ok: true, result, status: await allStatus() });
      return;
    }

    if (req.method === "POST" && pathname === "/api/upload-tokens") {
      const payload = await readJsonBody(req);
      const result = await withOperation("upload-tokens", () => handleUploadTokenChange(payload));
      sendJson(res, 200, { ok: true, result, status: await allStatus() });
      return;
    }

    const webModeMatch = pathname.match(/^\/api\/services\/web\/mode\/([^/]+)$/);
    if (req.method === "POST" && webModeMatch) {
      const result = await withOperation("web-mode", () => handleWebModeChange(webModeMatch[1]));
      sendJson(res, 200, { ok: true, result, status: await allStatus() });
      return;
    }

    const serviceMatch = pathname.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
    if (req.method === "POST" && serviceMatch) {
      const result = await withOperation(serviceMatch[1] + ":" + serviceMatch[2], () => handleAction(serviceMatch[1], serviceMatch[2]));
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

if (require.main === module) server.listen(PORT, HOST, () => {
  console.log(`Service Manager listening on http://${HOST}:${PORT}`);
  if (MANAGER_BASE_PATH) {
    console.log(`Service Manager base path: ${MANAGER_BASE_PATH}`);
  }
  console.log(
    `Service Manager auth: ${MANAGER_AUTH_ENABLED ? `enabled for ${MANAGER_AUTH_USERNAME}` : "disabled"}`
  );
});

module.exports = {
  server, html, withOperation, handleAction, handleStackAction,
  handleWebModeChange, getServiceStatus, getDatabaseStatus, runStackActions,
  waitForProcessHealth, serviceMap, cleanPowerShellError, managerStatus
};

function html() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Service Manager</title>
  <style>
    /* =====================================================================
       MMVB Service Manager — "Drafting Sheet" console
       The page is drawn as an engineering document: a bordered sheet on
       grid paper, DIN lettering, a title block for runtime metadata,
       rubber-stamp status marks, a ledger with dotted leaders, and an
       output recorder on graph paper. No glass, no glow, no gradients.
       ===================================================================== */
    :root {
      color-scheme: light;
      --paper: #EAE7DE;
      --paper-raised: #F5F2EA;
      --paper-deep: #DDD8C9;
      --screen: #E4E0D1;
      --ink: #262419;
      --ink-soft: #4A4738;
      --ink-2: #5B5747;
      --ink-faint: #8F8A76;
      --rule: #CCC6B1;
      --rule-strong: #A59E85;
      --red: #B23A2E;
      --red-deep: #8E2B22;
      --green: #2E6B47;
      --amber: #96660F;
      --blue: #3A6491;
      --font-display: Bahnschrift, "Segoe UI", "Microsoft YaHei UI", sans-serif;
      --font-mono: "Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace;
      --hard-shadow: 4px 4px 0 rgba(38, 36, 25, .13);
      --hard-shadow-lg: 8px 8px 0 rgba(38, 36, 25, .15);
    }

    * { box-sizing: border-box; }

    ::selection {
      background: var(--ink);
      color: var(--paper);
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0"/></filter><rect width="180" height="180" filter="url(%23n)"/></svg>'),
        radial-gradient(1200px 520px at 50% -10%, rgba(255, 255, 255, .5), transparent 70%),
        linear-gradient(rgba(58, 100, 145, .05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(58, 100, 145, .05) 1px, transparent 1px),
        linear-gradient(rgba(58, 100, 145, .075) 1px, transparent 1px),
        linear-gradient(90deg, rgba(58, 100, 145, .075) 1px, transparent 1px),
        var(--paper);
      background-size: 180px 180px, auto, 26px 26px, 26px 26px, 130px 130px, 130px 130px, auto;
      color: var(--ink);
      font-family: var(--font-display);
      font-size: 13px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    button, input, select { font: inherit; }

    a { color: inherit; text-decoration: none; }

    button, a, input { -webkit-tap-highlight-color: transparent; }

    :focus-visible {
      outline: 2px dashed var(--blue);
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

    /* ---- The sheet ------------------------------------------------------- */
    main.sheet {
      position: relative;
      width: min(1600px, calc(100% - 36px));
      margin: 20px auto 48px;
      border: 1.5px solid var(--ink);
      outline: 1px solid var(--rule-strong);
      outline-offset: 4px;
      background: linear-gradient(rgba(255, 255, 255, .4), rgba(255, 255, 255, 0) 220px), var(--paper-raised);
      box-shadow: var(--hard-shadow-lg);
      padding-bottom: 26px;
    }

    /* Registration crosses at two corners of the sheet */
    main.sheet::before,
    main.sheet::after {
      content: "";
      position: absolute;
      width: 11px;
      height: 11px;
      pointer-events: none;
      background:
        linear-gradient(var(--ink), var(--ink)) center / 1.5px 100% no-repeat,
        linear-gradient(var(--ink), var(--ink)) center / 100% 1.5px no-repeat;
    }

    main.sheet::before { top: -18px; left: -18px; }
    main.sheet::after { bottom: -18px; right: -18px; }

    /* ---- Masthead --------------------------------------------------------- */
    .masthead {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px 32px;
      align-items: start;
      padding: 24px 28px 20px;
      animation: rise .4s ease-out both;
    }

    .identity { min-width: 0; }

    .eyebrow {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin: 0;
      color: var(--blue);
      font: 700 10px/1 var(--font-display);
      letter-spacing: .22em;
      text-transform: uppercase;
    }

    .eyebrow::before {
      content: "";
      width: 8px;
      height: 8px;
      background: var(--red);
    }

    .eyebrow-tag {
      padding-left: 11px;
      border-left: 1px solid var(--rule-strong);
      color: var(--ink-faint);
      font: 500 9px/1 var(--font-mono);
      letter-spacing: .12em;
    }

    h1 {
      margin: 10px 0 0;
      font: 700 clamp(26px, 2.6vw, 34px)/0.95 var(--font-display);
      font-stretch: semi-condensed;
      letter-spacing: .02em;
      text-transform: uppercase;
    }

    .subhead {
      margin: 9px 0 0;
      max-width: 560px;
      color: var(--ink-2);
      font-size: 12px;
      line-height: 1.5;
    }

    .tally {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 16px;
    }

    .tally-chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 26px;
      border: 1px solid var(--rule-strong);
      border-radius: 2px;
      background: var(--paper);
      color: var(--ink-2);
      padding: 0 9px;
      cursor: pointer;
      font: 700 9px/1 var(--font-display);
      letter-spacing: .13em;
      text-transform: uppercase;
      transition: border-color .12s ease, color .12s ease, background .12s ease;
    }

    .tally-chip i {
      width: 7px;
      height: 7px;
      background: var(--red);
    }

    .tally-chip.ok i { background: var(--green); }
    .tally-chip.warn i { background: var(--amber); }

    .tally-chip:hover {
      border-color: var(--ink);
      background: var(--paper-raised);
      color: var(--ink);
    }

    .mast-side {
      display: grid;
      gap: 16px;
      justify-items: end;
    }

    /* The title block — manager runtime data, as on a drawing sheet */
    .titleblock {
      max-width: 100%;
      border: 1.5px solid var(--ink);
      background: var(--paper);
      box-shadow: var(--hard-shadow);
    }

    .tb-tag {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 6px 10px 5px;
      border-bottom: 1px solid var(--ink);
      background: var(--paper-deep);
      color: var(--ink-2);
      font: 600 8.5px/1 var(--font-mono);
      letter-spacing: .14em;
      text-transform: uppercase;
    }

    .tb-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(92px, auto));
    }

    .tb-field {
      min-width: 0;
      padding: 9px 12px 8px;
      border-left: 1px solid var(--rule-strong);
    }

    .tb-field:first-child { border-left: 0; }

    .tb-field span {
      display: block;
      color: var(--ink-faint);
      font: 700 8px/1 var(--font-display);
      letter-spacing: .17em;
      text-transform: uppercase;
    }

    .tb-field strong {
      display: block;
      margin-top: 6px;
      overflow-wrap: anywhere;
      font: 550 11px/1.25 var(--font-mono);
      letter-spacing: -.01em;
    }

    .commands {
      display: grid;
      gap: 8px;
      justify-items: end;
    }

    .command-label {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      color: var(--ink-faint);
      font: 600 9px/1 var(--font-mono);
      letter-spacing: .14em;
      text-transform: uppercase;
    }

    .command-label::after {
      content: "";
      width: 20px;
      height: 1px;
      background: var(--rule-strong);
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 7px;
    }

    /* ---- Buttons — mechanical, hard-edged, offset print shadow ------------ */
    .button {
      min-height: 32px;
      border: 1.5px solid var(--ink);
      border-radius: 2px;
      background: var(--paper-raised);
      color: var(--ink);
      padding: 0 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      font: 700 10px/1 var(--font-display);
      letter-spacing: .1em;
      text-transform: uppercase;
      white-space: nowrap;
      box-shadow: 2.5px 2.5px 0 rgba(38, 36, 25, .18);
      transition: background .12s ease, color .12s ease, box-shadow .12s ease, transform .12s ease, border-color .12s ease;
    }

    .button:hover { background: var(--paper-deep); }

    .button:active {
      transform: translate(2px, 2px);
      box-shadow: 0 0 0 rgba(0, 0, 0, 0);
    }

    .button:disabled {
      cursor: wait;
      opacity: .45;
      transform: none;
      box-shadow: none;
    }

    .button.primary {
      border-color: var(--ink);
      background: var(--ink);
      color: var(--paper-raised);
    }

    .button.primary:hover { background: #3B3828; }

    .button.warn {
      border-color: var(--blue);
      background: transparent;
      color: var(--blue);
    }

    .button.warn:hover { background: rgba(58, 100, 145, .1); }

    .button.danger {
      border-color: var(--red);
      background: transparent;
      color: var(--red);
    }

    .button.danger:hover { background: rgba(178, 58, 46, .09); }

    .toolbar .button {
      min-width: 92px;
      min-height: 36px;
    }

    /* ---- Scale ruler under the masthead ----------------------------------- */
    .ruler {
      height: 15px;
      margin: 0 28px;
      border-bottom: 1.5px solid var(--ink);
      background:
        repeating-linear-gradient(90deg, var(--ink-soft) 0 1px, transparent 1px 10px) left bottom / 100% 5px no-repeat,
        repeating-linear-gradient(90deg, var(--ink) 0 1px, transparent 1px 50px) left bottom / 100% 11px no-repeat;
      opacity: .8;
    }

    /* ---- Sections ---------------------------------------------------------- */
    .section {
      padding: 24px 28px 0;
      animation: rise .4s ease-out both;
    }

    .section:nth-of-type(1) { animation-delay: .05s; }
    .section:nth-of-type(2) { animation-delay: .1s; }
    .section:nth-of-type(3) { animation-delay: .15s; }
    .section:nth-of-type(4) { animation-delay: .2s; }

    .section-head {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 11px;
    }

    .section-no {
      padding: 4px 6px 3px;
      border: 1.5px solid var(--ink);
      background: var(--ink);
      color: var(--paper-raised);
      font: 700 10px/1 var(--font-mono);
      letter-spacing: .08em;
    }

    .section-name {
      margin: 0;
      font: 700 12px/1 var(--font-display);
      letter-spacing: .24em;
      text-transform: uppercase;
    }

    .section-rule {
      flex: 1;
      border-top: 1px solid var(--rule-strong);
      transform: translateY(-3px);
    }

    .section-note {
      color: var(--ink-faint);
      font: 500 9px/1 var(--font-mono);
      letter-spacing: .1em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    /* ---- 01 · Status record strip ------------------------------------------ */
    .record {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      border: 1.5px solid var(--ink);
      background: var(--paper);
      box-shadow: var(--hard-shadow);
    }

    .record-cell {
      position: relative;
      min-width: 0;
      padding: 13px 15px 12px;
      border-left: 1px solid var(--rule-strong);
    }

    .record-cell:first-child { border-left: 0; }

    .record-cell::after {
      content: "";
      position: absolute;
      top: 7px;
      right: 7px;
      width: 7px;
      height: 7px;
      border-top: 1px solid var(--rule-strong);
      border-right: 1px solid var(--rule-strong);
    }

    .record-label {
      display: block;
      color: var(--ink-faint);
      font: 700 8.5px/1 var(--font-display);
      letter-spacing: .18em;
      text-transform: uppercase;
    }

    .record-value {
      display: block;
      margin-top: 9px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 600 21px/1 var(--font-mono);
      letter-spacing: -.02em;
    }

    .record-cell.ok .record-value { color: var(--green); }
    .record-cell.alert .record-value { color: var(--red); }

    /* ---- 02 · Equipment bay — bill-of-materials rows ------------------------ */
    .bay {
      overflow: hidden;
      border: 1.5px solid var(--ink);
      background: var(--paper);
      box-shadow: var(--hard-shadow);
    }

    .svc {
      position: relative;
      padding: 0 16px 0 21px;
      transition: background .15s ease;
    }

    .svc::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      background: var(--red);
      opacity: .85;
    }

    .svc.ok::before { background: var(--green); }
    .svc.warn::before { background: var(--amber); }

    .svc + .svc { border-top: 1px solid var(--rule-strong); }

    .svc:hover { background: var(--paper-raised); }

    .svc.flash { animation: svc-flash 1.1s ease-out; }

    .svc-ident {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 13px 0 11px;
    }

    .svc-no {
      flex: 0 0 auto;
      padding: 5px 6px 4px;
      border: 1px solid var(--rule-strong);
      background: var(--paper-deep);
      color: var(--ink-2);
      font: 700 11px/1 var(--font-mono);
      letter-spacing: .06em;
    }

    .svc-name {
      flex: 1;
      min-width: 0;
    }

    .svc-name h2 {
      margin: 0;
      font: 700 15px/1.2 var(--font-display);
      font-stretch: semi-condensed;
      letter-spacing: .015em;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }

    .svc-meta {
      margin: 4px 0 0;
      overflow-wrap: anywhere;
      color: var(--ink-2);
      font: 9.5px/1.4 var(--font-mono);
    }

    /* Rubber stamp — rotated, multiply-blended onto the paper */
    .stamp {
      position: relative;
      flex: 0 0 auto;
      padding: 5px 9px 4px;
      border: 2px solid currentColor;
      border-radius: 2px;
      color: var(--ink-2);
      font: 800 10px/1 var(--font-display);
      letter-spacing: .16em;
      text-transform: uppercase;
      transform: rotate(-2deg);
      mix-blend-mode: multiply;
      opacity: .92;
    }

    .stamp::after {
      content: "";
      position: absolute;
      inset: 2px;
      border: 1px solid currentColor;
      border-radius: 1px;
      opacity: .45;
    }

    .stamp.ok { color: var(--green); }
    .stamp.warn { color: var(--amber); }
    .stamp.off { color: var(--red); }

    .svc.flash .stamp { animation: stamp-hit .5s ease-out; }

    .svc-spec {
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 1px;
      border-block: 1px solid var(--rule);
      background: var(--rule);
    }

    .spec {
      min-width: 0;
      padding: 8px 12px 7px;
      background: var(--paper);
      transition: background .15s ease;
    }

    .svc:hover .spec { background: var(--paper-raised); }

    .spec span {
      display: block;
      color: var(--ink-faint);
      font: 700 8px/1 var(--font-display);
      letter-spacing: .16em;
      text-transform: uppercase;
    }

    .spec strong {
      display: block;
      margin-top: 6px;
      overflow-wrap: anywhere;
      font: 550 11px/1.35 var(--font-mono);
    }

    .svc-ops {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 11px 0 13px;
    }

    .push { margin-left: auto; }

    .mode-switch {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px;
      border: 1.5px solid var(--ink);
      border-radius: 2px;
      background: var(--paper-deep);
      padding: 2px;
      margin-right: 6px;
    }

    .mode-switch .button {
      min-height: 27px;
      border: 0;
      background: transparent;
      box-shadow: none;
      color: var(--ink-2);
      font-size: 9px;
      letter-spacing: .08em;
      padding-inline: 10px;
    }

    .mode-switch .button:hover { background: var(--paper-raised); }

    .mode-switch .button.active {
      background: var(--ink);
      color: var(--paper-raised);
    }

    .svc-ops .button {
      min-height: 31px;
      padding-inline: 11px;
      font-size: 9.5px;
      letter-spacing: .07em;
    }

    /* ---- 03 · Records: credentials form + database ledger ------------------- */
    .bench {
      display: grid;
      grid-template-columns: minmax(0, 1.7fr) minmax(300px, 1fr);
      gap: 16px;
      align-items: stretch;
    }

    .panel {
      min-width: 0;
      border: 1.5px solid var(--ink);
      background: var(--paper);
      box-shadow: var(--hard-shadow);
    }

    .panel-tag {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 9px 14px;
      border-bottom: 1px solid var(--ink);
      background: var(--paper-deep);
      color: var(--ink-2);
      font: 700 9.5px/1 var(--font-display);
      letter-spacing: .16em;
      text-transform: uppercase;
    }

    .path-chip {
      flex: 0 0 auto;
      padding: 4px 7px;
      border: 1px solid var(--rule-strong);
      background: var(--paper-raised);
      color: var(--ink-2);
      font: 500 9px/1 var(--font-mono);
      letter-spacing: .03em;
      text-transform: lowercase;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 55%;
    }

    .cred-desc {
      margin: 0;
      padding: 13px 15px 0;
      color: var(--ink-2);
      font-size: 11.5px;
      line-height: 1.55;
    }

    .token-form { padding: 12px 15px 15px; }

    .cred-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    .field {
      min-width: 0;
      padding: 12px 13px 13px;
      border: 1px dashed var(--rule-strong);
      background: rgba(255, 255, 255, .28);
      transition: border-color .15s ease;
    }

    .field:focus-within { border-color: var(--ink-2); }

    .field-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 9px;
    }

    .field-top label { font: 700 12.5px/1 var(--font-display); }

    .cred-state {
      color: var(--ink-faint);
      font: 500 9px/1.4 var(--font-mono);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .cred-state.configured { color: var(--green); font-weight: 600; }
    .cred-state.inherited { color: var(--amber); font-weight: 600; }

    .input-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 6px;
    }

    .cred-input {
      width: 100%;
      min-width: 0;
      height: 34px;
      border: 0;
      border-bottom: 1.5px solid var(--ink);
      border-radius: 0;
      outline: 0;
      background: transparent;
      color: var(--ink);
      padding: 0 2px;
      font: 500 11px/1 var(--font-mono);
      letter-spacing: .02em;
      transition: border-color .15s ease, background .15s ease;
    }

    .cred-input::placeholder { color: var(--ink-faint); }

    .cred-input:focus {
      border-bottom-color: var(--red);
      background: rgba(178, 58, 46, .05);
    }

    .field .button {
      min-height: 34px;
      padding-inline: 10px;
      font-size: 9.5px;
    }

    .field-help {
      margin: 9px 0 0;
      color: var(--ink-2);
      font-size: 9.5px;
      line-height: 1.55;
    }

    .field-help code {
      font-family: var(--font-mono);
      color: var(--ink);
      background: var(--paper-deep);
      padding: 1px 4px;
    }

    .share {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      margin-top: 11px;
      color: var(--ink-2);
      font-size: 10.5px;
      cursor: pointer;
    }

    .share input {
      width: 13px;
      height: 13px;
      accent-color: var(--ink);
    }

    .form-foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      margin-top: 15px;
      padding-top: 13px;
      border-top: 1px solid var(--rule-strong);
    }

    .form-foot p {
      margin: 0;
      max-width: 540px;
      color: var(--ink-faint);
      font-size: 9.5px;
      line-height: 1.55;
    }

    .form-foot .button { flex: 0 0 auto; }

    /* Database ledger — dotted leaders between label and value */
    .ledger {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: baseline;
      column-gap: 9px;
      padding: 2px 15px 6px;
    }

    .ledger span {
      padding: 10px 0 9px;
      border-bottom: 1px solid var(--rule);
      color: var(--ink-2);
      font: 700 8.5px/1.2 var(--font-display);
      letter-spacing: .13em;
      text-transform: uppercase;
    }

    .ledger i {
      align-self: center;
      height: 1px;
      border-top: 1px dotted var(--rule-strong);
    }

    .ledger strong {
      min-width: 0;
      max-width: 100%;
      padding: 10px 0 9px;
      border-bottom: 1px solid var(--rule);
      overflow-wrap: anywhere;
      text-align: right;
      font: 550 10.5px/1.4 var(--font-mono);
    }

    .ledger strong.good { color: var(--green); font-weight: 600; }
    .ledger strong.bad { color: var(--red); font-weight: 600; }

    /* ---- 04 · Output recorder — graph paper --------------------------------- */
    .recorder-frame {
      overflow: hidden;
      border: 1.5px solid var(--ink);
      background: var(--paper);
      box-shadow: var(--hard-shadow);
    }

    .rec-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 14px;
      padding: 11px 14px;
      border-bottom: 1px solid var(--ink);
      background: var(--paper-deep);
    }

    .rec-id {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .tally-light {
      flex: 0 0 auto;
      width: 11px;
      height: 11px;
      border-radius: 2px;
      border: 1px solid var(--rule-strong);
      background: var(--paper-raised);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, .25);
      transition: background .2s ease, box-shadow .2s ease;
    }

    .tally-light.is-live {
      background: var(--red);
      border-color: var(--red-deep);
      box-shadow: 0 0 8px rgba(178, 58, 46, .65);
      animation: rec-blink 1.6s ease-in-out infinite;
    }

    .rec-title {
      margin: 0;
      font: 700 12px/1 var(--font-display);
      letter-spacing: .22em;
      text-transform: uppercase;
    }

    .live-state {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 22px;
      padding: 0 8px;
      border: 1px solid var(--rule-strong);
      background: var(--paper-raised);
      color: var(--ink-2);
      font: 700 8.5px/1 var(--font-display);
      letter-spacing: .12em;
      text-transform: uppercase;
    }

    .live-state-dot {
      width: 5px;
      height: 5px;
      background: currentColor;
    }

    .live-state.live { color: var(--green); }
    .live-state.syncing { color: var(--blue); }
    .live-state.paused { color: var(--amber); }
    .live-state.error { color: var(--red); }

    .chan-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-inline: auto;
    }

    .chan-tab {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 30px;
      padding: 0 12px;
      border: 1.5px solid var(--rule-strong);
      border-radius: 2px;
      background: var(--paper-raised);
      color: var(--ink-2);
      cursor: pointer;
      font: 700 9.5px/1 var(--font-display);
      letter-spacing: .12em;
      text-transform: uppercase;
      transition: border-color .12s ease, background .12s ease, color .12s ease;
    }

    .tab-led {
      width: 6px;
      height: 6px;
      background: var(--ink-faint);
      opacity: .6;
      transition: background .2s ease, opacity .2s ease;
    }

    .chan-tab.is-online .tab-led {
      background: var(--green);
      opacity: 1;
    }

    .chan-tab:hover {
      border-color: var(--ink);
      color: var(--ink);
    }

    .chan-tab.active {
      border-color: var(--ink);
      background: var(--ink);
      color: var(--paper-raised);
      box-shadow: 2px 2px 0 rgba(38, 36, 25, .22);
    }

    .chan-tab.active .tab-led { opacity: 1; }
    .chan-tab:disabled { opacity: .5; cursor: wait; }

    .rec-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
    }

    .rate-switch {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px;
      border: 1.5px solid var(--ink);
      border-radius: 2px;
      background: var(--paper);
      padding: 2px;
    }

    .rate-switch .button {
      min-height: 24px;
      border: 0;
      background: transparent;
      box-shadow: none;
      color: var(--ink-2);
      padding-inline: 10px;
      font-size: 9px;
    }

    .rate-switch .button.active {
      background: var(--ink);
      color: var(--paper-raised);
    }

    .rec-controls > .button {
      min-height: 30px;
      padding-inline: 11px;
      font-size: 9.5px;
    }

    .rec-screen { position: relative; background: var(--screen); }

    /* Graph-paper baselines + the red margin rule */
    .rec-screen::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
      background:
        repeating-linear-gradient(0deg, rgba(58, 100, 145, .07) 0 1px, transparent 1px 26px),
        linear-gradient(90deg, transparent 44px, rgba(178, 58, 46, .3) 44px, rgba(178, 58, 46, .3) 45px, transparent 45px);
    }

    .log {
      position: relative;
      height: 420px;
      margin: 0;
      overflow: auto;
      padding: 4px 0 18px;
      font: 12px/1.7 var(--font-mono);
      scrollbar-color: var(--rule-strong) var(--screen);
    }

    .log::-webkit-scrollbar { width: 10px; height: 10px; }
    .log::-webkit-scrollbar-track { background: transparent; }

    .log::-webkit-scrollbar-thumb {
      background: var(--rule-strong);
      border-radius: 5px;
      border: 2px solid var(--screen);
    }

    .stream-gutter {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 6px;
      padding: 10px 18px 4px 58px;
      border-top: 1px dashed var(--rule-strong);
      font: 700 8.5px/1 var(--font-display);
      letter-spacing: .18em;
      text-transform: uppercase;
    }

    .stream:first-of-type .stream-gutter { border-top: 0; margin-top: 0; }

    .stream-gutter::before {
      content: "";
      width: 14px;
      height: 3px;
      background: currentColor;
    }

    .stream-stdout .stream-gutter { color: var(--green); }
    .stream-stderr .stream-gutter { color: var(--red); }

    .stream-name { flex: 0 0 auto; }

    .stream-file {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ink-faint);
      font: 9px/1 var(--font-mono);
      letter-spacing: .04em;
      text-transform: lowercase;
    }

    .stream-body {
      margin: 0;
      padding: 2px 18px 12px 58px;
      font: inherit;
    }

    .stream-line {
      display: block;
      color: #3B382C;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .stream-stderr .stream-line { color: #7E322A; }

    .stream-line.line-warn {
      color: var(--amber);
      box-shadow: inset 2px 0 0 var(--amber);
      padding-left: 6px;
    }

    .stream-line.line-err {
      color: var(--red-deep);
      font-weight: 600;
      background: rgba(178, 58, 46, .08);
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

    /* Mini scale ruler as the empty-state mark */
    .log-empty::before {
      content: "";
      width: 130px;
      height: 12px;
      margin-bottom: 14px;
      border-bottom: 1px solid var(--rule-strong);
      background:
        repeating-linear-gradient(90deg, var(--rule-strong) 0 1px, transparent 1px 10px) left bottom / 100% 6px no-repeat,
        repeating-linear-gradient(90deg, var(--ink-2) 0 1px, transparent 1px 40px) left bottom / 100% 11px no-repeat;
    }

    .log-empty.is-busy::before { animation: breathe 1.4s ease-in-out infinite; }

    .log-empty p {
      margin: 0;
      color: var(--ink-2);
      font: 500 12.5px/1.5 var(--font-display);
      letter-spacing: .04em;
    }

    .log-empty .log-empty-sub {
      color: var(--ink-faint);
      font-size: 9.5px;
    }

    .rec-foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      padding: 9px 14px 10px;
      border-top: 1px solid var(--ink);
      background: var(--paper-deep);
    }

    .follow-pill {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 20px;
      padding: 0 8px;
      border: 1px solid var(--rule-strong);
      background: var(--paper-raised);
      color: var(--ink-faint);
      font: 700 8px/1 var(--font-display);
      letter-spacing: .14em;
      text-transform: uppercase;
    }

    .follow-pill::before {
      content: "";
      width: 5px;
      height: 5px;
      background: currentColor;
    }

    .follow-pill.on {
      color: var(--green);
      border-color: var(--green);
    }

    .output-meta {
      margin: 0;
      min-height: 14px;
      overflow-wrap: anywhere;
      color: var(--ink-2);
      font: 9.5px/1.5 var(--font-mono);
    }

    .action-readout {
      margin: 0 0 0 auto;
      max-width: 46%;
      overflow-wrap: anywhere;
      color: var(--blue);
      font: 600 9.5px/1.5 var(--font-mono);
      text-align: right;
    }

    .action-readout:empty { display: none; }

    .action-readout.error { color: var(--red); }

    .log-paths {
      flex-basis: 100%;
      margin: 0;
      padding-top: 7px;
      border-top: 1px dashed var(--rule-strong);
      overflow-wrap: anywhere;
      color: var(--ink-faint);
      font: 9px/1.5 var(--font-mono);
    }

    .log-paths:empty { display: none; }

    /* ---- Memo slip (toast) --------------------------------------------------- */
    .toast {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 80;
      max-width: min(460px, calc(100vw - 36px));
      border: 1.5px solid var(--ink);
      border-left: 4px solid var(--blue);
      border-radius: 2px;
      background: var(--paper-raised);
      box-shadow: 6px 6px 0 rgba(38, 36, 25, .2);
      padding: 12px 14px;
      color: var(--ink);
      font-size: 11.5px;
      line-height: 1.55;
      overflow-wrap: anywhere;
      transform: translateY(10px);
      opacity: 0;
      pointer-events: none;
      transition: transform .18s ease, opacity .18s ease;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    /* ---- Work order (confirm dialog) ------------------------------------------ */
    dialog.action-dialog {
      padding: 0;
      border: 1.5px solid var(--ink);
      border-radius: 2px;
      background: var(--paper-raised);
      color: var(--ink);
      max-width: min(480px, 92vw);
      box-shadow: 10px 10px 0 rgba(38, 36, 25, .22);
    }

    dialog.action-dialog::backdrop { background: rgba(38, 36, 25, .45); }

    .dlg-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      padding: 11px 16px;
      border-bottom: 1px solid var(--ink);
      background: var(--paper-deep);
    }

    .dlg-head h2 {
      margin: 0;
      font: 700 11px/1.3 var(--font-display);
      letter-spacing: .18em;
      text-transform: uppercase;
    }

    .dlg-stamp { font-size: 8.5px; padding: 4px 7px 3px; }

    .dlg-body {
      margin: 0;
      padding: 15px 16px;
      color: var(--ink-2);
      font-size: 12px;
      line-height: 1.6;
    }

    .dlg-ops {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 0 16px 16px;
    }

    /* ---- Motion ---------------------------------------------------------------- */
    @keyframes rise {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes svc-flash {
      0% { box-shadow: inset 0 0 0 2px var(--red); }
      70% { box-shadow: inset 0 0 0 2px rgba(178, 58, 46, .35); }
      100% { box-shadow: inset 0 0 0 2px transparent; }
    }

    @keyframes stamp-hit {
      0% { transform: rotate(-2deg) scale(1.28); opacity: .35; }
      60% { transform: rotate(-3deg) scale(.96); opacity: 1; }
      100% { transform: rotate(-2deg) scale(1); }
    }

    @keyframes breathe {
      0%, 100% { opacity: .25; }
      50% { opacity: .85; }
    }

    @keyframes rec-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: .5; }
    }

    /* First paint only: stagger the equipment rows in, then retire the flag */
    .boot .svc { animation: rise .4s ease-out both; }
    .boot .svc:nth-child(1) { animation-delay: .05s; }
    .boot .svc:nth-child(2) { animation-delay: .12s; }
    .boot .svc:nth-child(3) { animation-delay: .19s; }
    .boot .svc:nth-child(4) { animation-delay: .26s; }

    /* ---- Responsive -------------------------------------------------------------- */
    @media (max-width: 1200px) {
      .masthead { grid-template-columns: 1fr; }
      .mast-side { justify-items: start; }
      .commands { justify-items: start; }
      .toolbar { justify-content: flex-start; }
      .command-label::before { content: ""; width: 20px; height: 1px; background: var(--rule-strong); }
      .command-label::after { display: none; }
    }

    @media (max-width: 1100px) {
      .bench { grid-template-columns: 1fr; }
      .ledger strong { max-width: 60%; }
    }

    @media (max-width: 900px) {
      .tb-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tb-field { border-top: 1px solid var(--rule-strong); }
      .tb-field:nth-child(-n+2) { border-top: 0; }
      .tb-field:nth-child(odd) { border-left: 0; }
      .rec-head { align-items: flex-start; }
      .chan-tabs {
        order: 3;
        flex-basis: 100%;
        margin-inline: 0;
        flex-wrap: nowrap;
        overflow-x: auto;
        padding-bottom: 2px;
      }
      .chan-tab { flex: 1 0 auto; justify-content: center; }
      .log { height: 340px; }
      .action-readout {
        max-width: 100%;
        margin-left: 0;
        flex-basis: 100%;
        order: 5;
        text-align: left;
      }
    }

    @media (max-width: 700px) {
      main.sheet { width: calc(100% - 22px); margin: 14px auto 36px; }
      .masthead { padding: 18px 16px 14px; }
      .ruler { margin: 0 16px; }
      .section { padding: 20px 16px 0; }
      .cred-grid { grid-template-columns: 1fr; }
      .toolbar { width: 100%; }
      .toolbar .button { flex: 1 1 auto; }
      .input-row { grid-template-columns: minmax(0, 1fr) auto; }
      .input-row .button[data-token-toggle] { grid-column: 1 / -1; }
      .form-foot { align-items: stretch; flex-direction: column; }
      .form-foot .button { width: 100%; }
      .panel-tag { flex-wrap: wrap; }
      .path-chip { max-width: 100%; }
      .log { height: 300px; }
      .stream-gutter, .stream-body { padding-inline: 14px; }
    }

    @media (max-width: 480px) {
      .record { grid-template-columns: 1fr; }
      .record-cell { border-left: 0; border-top: 1px solid var(--rule-strong); }
      .record-cell:first-child { border-top: 0; }
      .record-cell { min-height: 0; }
      .svc-ident { flex-wrap: wrap; gap: 10px; }
      .svc-name { flex-basis: calc(100% - 60px); }
      .rec-controls { width: 100%; justify-content: space-between; }
      .log { height: 260px; font-size: 11.5px; }
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
  <main id="managerApp" class="sheet boot" aria-busy="false">
    <header class="masthead">
      <div class="identity">
        <p class="eyebrow">MMVB · Master Control<span class="eyebrow-tag">Form SM-01 · Local Ops</span></p>
        <h1>Service Manager</h1>
        <p class="subhead">Live process control, diagnostics, and publishing credentials for the local media stack.</p>
        <div class="tally" id="tally" aria-label="Service tally — select to locate a row"></div>
      </div>
      <div class="mast-side">
        <div class="titleblock" aria-label="Manager runtime">
          <div class="tb-tag"><span>Control unit</span><span>MMVB/SM</span></div>
          <div class="tb-grid" id="managerMeta"></div>
        </div>
        <div class="commands">
          <p class="command-label">Stack commands</p>
          <div class="toolbar" role="group" aria-label="Full stack controls">
            <button class="button primary" type="button" data-stack="start-all">Start All</button>
            <button class="button warn" type="button" data-stack="restart-all">Restart All</button>
            <button class="button danger" type="button" data-stack="stop-all">Stop All</button>
            <button class="button" type="button" id="refreshButton">Refresh</button>
          </div>
        </div>
      </div>
    </header>

    <div class="ruler" aria-hidden="true"></div>

    <section class="section">
      <div class="section-head">
        <span class="section-no">01</span>
        <h2 class="section-name">Status record</h2>
        <span class="section-rule" aria-hidden="true"></span>
        <span class="section-note">Auto-sync 2s</span>
      </div>
      <div class="record" id="summary" aria-label="Stack status overview">
        <div class="record-cell" id="sumRunning">
          <span class="record-label">Running</span>
          <strong class="record-value">—</strong>
        </div>
        <div class="record-cell" id="sumHealthy">
          <span class="record-label">Healthy</span>
          <strong class="record-value">—</strong>
        </div>
        <div class="record-cell" id="sumStopped">
          <span class="record-label">Stopped</span>
          <strong class="record-value">—</strong>
        </div>
        <div class="record-cell" id="sumSync">
          <span class="record-label">Last sync</span>
          <strong class="record-value">—</strong>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="section-no">02</span>
        <h2 class="section-name">Equipment bay</h2>
        <span class="section-rule" aria-hidden="true"></span>
        <span class="section-note">4 units · local stack</span>
      </div>
      <div class="bay" id="cards" aria-label="Managed services"></div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="section-no">03</span>
        <h2 class="section-name">Records</h2>
        <span class="section-rule" aria-hidden="true"></span>
        <span class="section-note">credentials · database</span>
      </div>
      <div class="bench">
        <section class="panel" aria-label="Publishing credentials">
          <div class="panel-tag">
            <span>Part A · Publishing credentials</span>
            <span class="path-chip" id="tokenPath">apps/api/.env</span>
          </div>
          <p class="cred-desc">Manage browser publishing credentials in one place. Existing values stay hidden; each save restarts the Upload API so changes take effect immediately.</p>
          <form class="token-form" id="tokenForm" novalidate>
            <div class="cred-grid">
              <div class="field">
                <div class="field-top">
                  <label for="uploadToken">Video &amp; albums</label>
                  <span class="cred-state" id="uploadTokenStatus">Checking...</span>
                </div>
                <div class="input-row">
                  <input class="cred-input" id="uploadToken" name="uploadToken" type="password" autocomplete="new-password" spellcheck="false" minlength="24" maxlength="256" placeholder="Leave blank to keep current" aria-describedby="uploadTokenHelp" />
                  <button class="button" type="button" data-token-generate="uploadToken">Generate</button>
                  <button class="button" type="button" data-token-toggle="uploadToken" aria-label="Show video and album token">Show</button>
                </div>
                <p class="field-help" id="uploadTokenHelp"><code>UPLOAD_API_TOKEN</code> protects video uploads, albums, photos, and film-scan jobs.</p>
              </div>

              <div class="field">
                <div class="field-top">
                  <label for="articleToken">Articles</label>
                  <span class="cred-state" id="articleTokenStatus">Checking...</span>
                </div>
                <div class="input-row">
                  <input class="cred-input" id="articleToken" name="articleToken" type="password" autocomplete="new-password" spellcheck="false" minlength="24" maxlength="256" placeholder="Leave blank to keep current" aria-describedby="articleTokenHelp" />
                  <button class="button" type="button" data-token-generate="articleToken">Generate</button>
                  <button class="button" type="button" data-token-toggle="articleToken" aria-label="Show article token">Show</button>
                </div>
                <label class="share" for="articleUsesUploadToken">
                  <input id="articleUsesUploadToken" name="articleUsesUploadToken" type="checkbox" />
                  Use the video &amp; album token for articles
                </label>
                <p class="field-help" id="articleTokenHelp"><code>ARTICLE_API_TOKEN</code> protects the article editor and can intentionally share the primary token.</p>
              </div>
            </div>
            <div class="form-foot">
              <p>Stored token text is never returned to this page. The short code beside each status is a one-way fingerprint for identifying the active credential.</p>
              <button class="button primary" type="submit" id="saveTokensButton">Save tokens &amp; restart API</button>
            </div>
          </form>
        </section>

        <aside class="panel" aria-label="Database register">
          <div class="panel-tag">
            <span>Part B · Database register</span>
            <span class="path-chip">PostgreSQL</span>
          </div>
          <div class="ledger" id="databaseMeta"></div>
        </aside>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <span class="section-no">04</span>
        <h2 class="section-name">Output recorder</h2>
        <span class="section-rule" aria-hidden="true"></span>
        <span class="section-note">web · api · cms · manager</span>
      </div>
      <section class="recorder-frame" id="outputMonitor" aria-label="Live output monitor">
        <header class="rec-head">
          <div class="rec-id">
            <span class="tally-light" id="tallyLight" aria-hidden="true"></span>
            <h3 class="rec-title">Signal</h3>
            <span class="live-state" id="liveLogState"><span class="live-state-dot" aria-hidden="true"></span><span id="liveLogStateText">Idle</span></span>
          </div>
          <div class="chan-tabs" role="group" aria-label="Live output source">
            <button class="chan-tab" type="button" data-log="web" aria-pressed="false"><i class="tab-led" aria-hidden="true"></i>Web</button>
            <button class="chan-tab" type="button" data-log="api" aria-pressed="false"><i class="tab-led" aria-hidden="true"></i>API</button>
            <button class="chan-tab" type="button" data-log="cms" aria-pressed="false"><i class="tab-led" aria-hidden="true"></i>CMS</button>
            <button class="chan-tab" type="button" data-log="manager" aria-pressed="false"><i class="tab-led" aria-hidden="true"></i>Manager</button>
          </div>
          <div class="rec-controls">
            <div class="rate-switch" role="group" aria-label="Live output refresh interval">
              <button class="button active" type="button" data-log-interval="3000" aria-pressed="true">3s</button>
              <button class="button" type="button" data-log-interval="10000" aria-pressed="false">10s</button>
            </div>
            <button class="button" type="button" id="toggleLogPolling" aria-pressed="false">Pause</button>
          </div>
        </header>
        <div class="rec-screen">
          <div class="log" id="log" role="region" aria-label="Live service output" aria-live="off" tabindex="0">
            <div class="log-empty is-busy"><p>Acquiring Web channel</p><p class="log-empty-sub">Connecting to the live output buffer...</p></div>
          </div>
        </div>
        <footer class="rec-foot">
          <span class="follow-pill on" id="followPill" title="Auto-scrolling to newest output">Follow</span>
          <p class="output-meta" id="liveLogMeta" role="status" aria-live="polite">Waiting for a log source.</p>
          <p class="action-readout" id="actionReadout" role="status" aria-live="polite"></p>
          <p class="log-paths" id="logPaths"></p>
        </footer>
      </section>
    </section>
  </main>

  <dialog id="actionDialog" class="action-dialog" aria-labelledby="actionDialogTitle" aria-describedby="actionDialogMessage">
    <form method="dialog">
      <div class="dlg-head">
        <h2 id="actionDialogTitle">Confirm service operation</h2>
        <span class="stamp off dlg-stamp" aria-hidden="true">Review</span>
      </div>
      <p class="dlg-body" id="actionDialogMessage"></p>
      <div class="dlg-ops">
        <button class="button" value="cancel" autofocus>Cancel</button>
        <button class="button warn" id="actionDialogConfirm" value="confirm">Continue</button>
      </div>
    </form>
  </dialog>
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
    let bootDone = false;
    let tokenFormDirty = false;
    let toastTimer = null;
    let refreshPromise = null;
    let statusRefreshing = false;
    let statusGeneration = 0;
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
      if (nextBusy) statusGeneration++;
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

    let confirmationPending = false;
    async function confirmAction(message, label) {
      if (confirmationPending || busy) return false;
      confirmationPending = true;
      const dialog = document.getElementById("actionDialog");
      document.getElementById("actionDialogMessage").textContent = message;
      document.getElementById("actionDialogConfirm").textContent = label;
      dialog.returnValue = "cancel";
      try {
        return await new Promise((resolve) => {
          dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
          dialog.showModal();
        });
      } finally { confirmationPending = false; }
    }

    function notify(message) {
      clearTimeout(toastTimer);
      toast.textContent = message;
      toast.classList.add("show");
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
    }

    function setActionReadout(text, tone) {
      actionReadout.textContent = text || "";
      actionReadout.className = "action-readout" + (tone ? " " + tone : "");
    }

    function apiPath(path) {
      return API_BASE + path;
    }

    function serviceState(item) {
      if (item.healthy) return { label: "Healthy", cls: "ok" };
      if (item.running) return { label: "Degraded", cls: "warn" };
      return { label: "Stopped", cls: "off" };
    }

    function stampHtml(item) {
      const status = serviceState(item);
      return '<span class="stamp ' + status.cls + '" aria-label="Status: ' + esc(status.label) + '">' + esc(status.label) + '</span>';
    }

    function specCell(label, value) {
      return '<div class="spec"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
    }

    function serviceCard(item, index) {
      const status = serviceState(item);
      const meta = item.kind === "windows-service"
        ? item.serviceName
        : item.healthUrl;
      const pids = item.pids && item.pids.length ? item.pids.join(", ") : "N/A";
      let specs;
      if (item.kind === "windows-service") {
        specs = [
          specCell("Service", item.serviceName),
          specCell("State", item.status),
          specCell("Start type", item.startType),
          specCell("DB check", item.error || (item.healthy ? "OK" : "N/A"))
        ];
      } else if (item.id === "web") {
        specs = [
          specCell("Port", item.port),
          specCell("PID", pids),
          specCell("HTTP", item.status || item.error),
          specCell("Latency", item.elapsed != null ? item.elapsed + "ms" : "N/A"),
          specCell("Mode", item.modeLabel),
          specCell("Script", item.startScript)
        ];
      } else {
        specs = [
          specCell("Port", item.port),
          specCell("PID", pids),
          specCell("HTTP", item.status || item.error),
          specCell("Latency", item.elapsed != null ? item.elapsed + "ms" : "N/A")
        ];
      }
      const open = item.openUrl
        ? '<a class="button" href="' + esc(item.openUrl) + '" target="_blank" rel="noreferrer" aria-label="Open ' + esc(item.name) + '">Open</a>'
        : "";
      const logs = item.logName
        ? '<button class="button" type="button" data-log="' + esc(item.id) + '" aria-label="Watch ' + esc(item.name) + ' in the output recorder">Logs</button>'
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

      return '<article class="svc ' + status.cls + '" data-card="' + esc(item.id) + '" aria-labelledby="service-' + esc(item.id) + '-title">'
        + '<div class="svc-ident">'
        + '<span class="svc-no" aria-hidden="true">' + String(index + 1).padStart(2, "0") + '</span>'
        + '<div class="svc-name"><h2 id="service-' + esc(item.id) + '-title">' + esc(item.name) + '</h2>'
        + '<p class="svc-meta">' + esc(item.category) + " · " + esc(meta) + '</p></div>'
        + stampHtml(item)
        + '</div>'
        + '<div class="svc-spec">' + specs.join("") + '</div>'
        + '<div class="svc-ops">'
        + webMode
        + '<button class="button primary push" type="button" data-action="start" data-id="' + esc(item.id) + '" aria-label="Start ' + esc(item.name) + '">Start</button>'
        + '<button class="button warn" type="button" data-action="restart" data-id="' + esc(item.id) + '" aria-label="Restart ' + esc(item.name) + '">Restart</button>'
        + rebuild
        + '<button class="button danger" type="button" data-action="stop" data-id="' + esc(item.id) + '" aria-label="Stop ' + esc(item.name) + '">Stop</button>'
        + open
        + logs
        + '</div>'
        + '</article>';
    }

    function tbField(label, value) {
      return '<div class="tb-field"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
    }

    function ledgerRow(label, value, tone) {
      return '<span>' + esc(label) + '</span><i aria-hidden="true"></i><strong'
        + (tone ? ' class="' + tone + '"' : '') + '>' + esc(value) + '</strong>';
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
        element.className = "cred-state"
          + (item.configured ? " configured" : "")
          + (item.inherited ? " inherited" : "");
      }

      if (!tokenFormDirty && article) {
        articleUsesUploadToken.checked = article.inherited;
        syncArticleTokenInput();
      }
    }

    function setRecordCell(id, value, tone) {
      const cell = document.getElementById(id);
      if (!cell) return;
      cell.querySelector(".record-value").textContent = value;
      cell.classList.toggle("ok", tone === "ok");
      cell.classList.toggle("alert", tone === "alert");
    }

    function renderSummary(data) {
      const total = data.services.length;
      const running = data.services.filter((item) => item.running).length;
      const healthy = data.services.filter((item) => item.healthy).length;
      const stopped = total - running;
      setRecordCell("sumRunning", running + " / " + total, running === total ? "ok" : "");
      setRecordCell("sumHealthy", healthy + " / " + total, healthy === total ? "ok" : "");
      setRecordCell("sumStopped", String(stopped), stopped > 0 ? "alert" : "");
      setRecordCell("sumSync", new Date(data.updatedAt).toLocaleTimeString(), "");
    }

    function render(data) {
      state = data;
      renderSummary(data);
      document.title = data.services.filter((item) => item.healthy).length + "/" + data.services.length + " healthy · Service Manager";

      renderTally(data);
      cards.innerHTML = data.services.map(serviceCard).join("");
      if (busy) cards.querySelectorAll("button").forEach((button) => { button.disabled = true; });
      if (!bootDone) {
        bootDone = true;
        setTimeout(() => managerApp.classList.remove("boot"), 800);
      }
      updateLogControls();
      renderUploadTokens(data.uploadTokens);
      managerMeta.innerHTML = [
        tbField("Host", data.manager.host + ":" + data.manager.port),
        tbField("PID", data.manager.pid),
        tbField("Uptime", data.manager.uptime + "s"),
        tbField("Node", data.manager.node)
      ].join("");
      databaseMeta.innerHTML = [
        ledgerRow("Status", data.database.healthy ? "Healthy" : "Unavailable", data.database.healthy ? "good" : "bad"),
        ledgerRow("Path", data.database.path),
        ledgerRow("Tables", data.database.tables),
        ledgerRow("Posts", data.database.posts),
        ledgerRow("Projects", data.database.projects),
        ledgerRow("Masters", data.database.masters),
        ledgerRow("Error", data.database.error || "N/A", data.database.error ? "bad" : "")
      ].join("");
    }

    function refresh(silent = false) {
      if (refreshPromise) return refreshPromise;
      if (!silent) {
        statusRefreshing = true;
        updateLogControls();
      }
      const generation = statusGeneration;
      refreshPromise = (async () => {
        try {
          const response = await fetch(apiPath("/api/status"), { cache: "no-store", signal: AbortSignal.timeout(15000) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Status request failed");
          if (generation === statusGeneration) render(data);
        } catch (error) {
          if (!silent && generation === statusGeneration) {
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
        await refreshPromise;
        await refresh(true);
      } finally {
        setBusy(false);
      }
    }

    async function runStackAction(action) {
      if (busy) return;
      if (action === "stop-all" && !await confirmAction("Stop all managed services, including PostgreSQL?", "Stop all")) return;
      if (action === "restart-all" && !await confirmAction("Restart the full managed stack?", "Restart all")) return;
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
        await refreshPromise;
        await refresh(true);
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

      if (mode === "production" && !await confirmAction("Switch Frontend Web to Production mode? The frontend will stop while the production build runs.", "Switch to Production")) {
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
        await refreshPromise;
        await refresh(true);
      } finally {
        setBusy(false);
      }
    }

    async function saveUploadTokens() {
      if (busy) return;
      if (!tokenForm.checkValidity()) {
        const invalid = tokenForm.querySelector(":invalid");
        invalid?.setAttribute("aria-invalid", "true");
        invalid?.focus();
        setActionReadout("Token validation failed: " + (invalid?.validationMessage || "Check the token fields."), "error");
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
        setActionReadout(message, data.result.restartOk === false ? "error" : "");
        notify(message);
      } catch (error) {
        setActionReadout("Error: " + error.message, "error");
        notify(error.message);
        await refreshPromise;
        await refresh(true);
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
        if (!logButton.closest(".recorder-frame")) {
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

    tokenForm.addEventListener("input", (event) => {
      event.target.removeAttribute("aria-invalid");
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
