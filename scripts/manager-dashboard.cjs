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
// Only authenticated HTML exposes this nonce; a cross-site form cannot supply it.
const MANAGER_CSRF_TOKEN = crypto.randomBytes(32).toString("hex");
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
  // A reverse proxy is also a loopback peer, so missing credentials must fail closed.
  if (!MANAGER_AUTH_ENABLED) return false;

  const credentials = parseBasicAuth(req.headers.authorization);
  if (!credentials) return false;

  return (
    timingSafeStringEqual(credentials.username, MANAGER_AUTH_USERNAME) &&
    timingSafeStringEqual(credentials.password, MANAGER_AUTH_PASSWORD)
  );
}

function requireManagerMutation(req) {
  const origin = req.headers.origin;
  let sameOrigin = !origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      // Host survives the HTTPS reverse proxy; do not compare against backend HTTP.
      sameOrigin = ["http:", "https:"].includes(parsed.protocol) && parsed.host === req.headers.host;
    } catch { sameOrigin = false; }
  }
  if (!sameOrigin || req.headers["sec-fetch-site"] === "cross-site" ||
      !timingSafeStringEqual(req.headers["x-manager-csrf"] || "", MANAGER_CSRF_TOKEN)) {
    throw Object.assign(new Error("Invalid management request origin or CSRF token."), { statusCode: 403 });
  }
  if (String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw Object.assign(new Error("Content-Type must be application/json."), { statusCode: 415 });
  }
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

    if (!MANAGER_AUTH_ENABLED) {
      sendJson(res, 503, { ok: false, error: "Set MANAGER_AUTH_PASSWORD before using the management HTTP interface." });
      return;
    }

    if (!isAuthenticated(req)) {
      sendAuthRequired(res);
      return;
    }

    // One guard covers every current and future POST before it can produce side effects.
    if (req.method === "POST") requireManagerMutation(req);

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
    `Service Manager auth: ${MANAGER_AUTH_ENABLED ? `enabled for ${MANAGER_AUTH_USERNAME}` : "not configured; HTTP access disabled"}`
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
  <meta name="color-scheme" content="light dark" />
  <title>Service Manager</title>
  <style>
    /* Service Manager — status-first console.
       One question answered first: is the stack running normally?
       Overview banner -> per-service cards -> live output -> records. */
    :root {
      color-scheme: light dark;
      --bg: #f3f4f7;
      --surface: #ffffff;
      --surface-2: #f7f8fa;
      --line: #e2e5eb;
      --line-strong: #c9ced8;
      --text: #151821;
      --muted: #596273;
      --accent: #2456d4;
      --accent-ink: #ffffff;
      --ok: #167a46;
      --ok-bg: #e5f4eb;
      --ok-line: #b5dcc4;
      --warn: #9a5500;
      --warn-bg: #fff0d6;
      --warn-line: #f0cf94;
      --bad: #c0262d;
      --bad-bg: #fde8e8;
      --bad-line: #f0b9bb;
      --idle: #596273;
      --idle-bg: #eceef2;
      --idle-line: #d5d9e1;
      --shadow: 0 1px 2px rgba(20, 24, 33, .05), 0 1px 1px rgba(20, 24, 33, .03);
      --radius: 10px;
      --radius-sm: 7px;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif;
      --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d1015;
        --surface: #151a21;
        --surface-2: #1b212a;
        --line: #262d38;
        --line-strong: #3a4352;
        --text: #e8ebf1;
        --muted: #9aa4b4;
        --accent: #6c97ff;
        --accent-ink: #0b1020;
        --ok: #4fd08a;
        --ok-bg: #12291d;
        --ok-line: #1f4a33;
        --warn: #f2b44d;
        --warn-bg: #2d2210;
        --warn-line: #55401a;
        --bad: #ff7d83;
        --bad-bg: #321619;
        --bad-line: #6a2a2f;
        --idle: #9aa4b4;
        --idle-bg: #1d232c;
        --idle-line: #303847;
        --shadow: none;
      }
    }

    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 var(--font);
      -webkit-font-smoothing: antialiased;
    }
    h1, h2, h3, p, dl, dd { margin: 0; }
    code, .mono { font-family: var(--mono); }
    code {
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--surface-2);
      border: 1px solid var(--line);
      font-size: 12px;
    }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .progress {
      position: fixed;
      inset: 0 0 auto 0;
      height: 3px;
      z-index: 20;
      overflow: hidden;
      opacity: 0;
      transition: opacity .2s;
      pointer-events: none;
    }
    .progress::after {
      content: "";
      display: block;
      width: 35%;
      height: 100%;
      background: var(--accent);
      animation: slide 1.1s ease-in-out infinite;
    }
    body:has(#managerApp[aria-busy="true"]) .progress { opacity: 1; }
    @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }

    .app {
      width: min(1120px, 100%);
      margin: 0 auto;
      padding: 24px 20px 40px;
      display: grid;
      gap: 20px;
    }
    .app > * { min-width: 0; }

    /* Top bar */
    .topbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .brand { flex: 1 1 auto; min-width: 0; }
    .eyebrow { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    h1 { font-size: 24px; line-height: 1.2; font-weight: 700; letter-spacing: -.01em; }
    .sync {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12.5px;
    }
    .sync-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); flex: none; }
    .sync[data-state="live"] .sync-dot { background: var(--ok); animation: pulse 2s ease-out infinite; }
    .sync[data-state="offline"] { color: var(--bad); border-color: var(--bad-line); background: var(--bad-bg); }
    .sync[data-state="offline"] .sync-dot { background: var(--bad); }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent); }
      70%, 100% { box-shadow: 0 0 0 6px transparent; }
    }

    /* Buttons */
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 34px;
      padding: 0 13px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-sm);
      background: var(--surface);
      color: var(--text);
      font: 600 13px/1 var(--font);
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
      transition: background-color .12s, border-color .12s, color .12s;
    }
    .button:hover:not(:disabled) { background: var(--surface-2); border-color: var(--muted); }
    .button:active:not(:disabled) { transform: translateY(1px); }
    .button:disabled { opacity: .5; cursor: not-allowed; }
    .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    .button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
    .button.warn { color: var(--warn); }
    .button.warn:hover:not(:disabled) { background: var(--warn-bg); border-color: var(--warn); }
    .button.danger { color: var(--bad); }
    .button.danger:hover:not(:disabled) { background: var(--bad-bg); border-color: var(--bad); }
    .button.active { background: var(--text); border-color: var(--text); color: var(--bg); }
    .button.active:hover:not(:disabled) { background: var(--text); }

    /* Overview banner */
    .overview {
      --tone: var(--idle);
      --tone-bg: var(--idle-bg);
      --tone-line: var(--idle-line);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px 24px;
      padding: 20px;
      border: 1px solid var(--tone-line);
      border-radius: var(--radius);
      background: var(--tone-bg);
    }
    .overview[data-tone="ok"] { --tone: var(--ok); --tone-bg: var(--ok-bg); --tone-line: var(--ok-line); }
    .overview[data-tone="warn"] { --tone: var(--warn); --tone-bg: var(--warn-bg); --tone-line: var(--warn-line); }
    .overview[data-tone="bad"] { --tone: var(--bad); --tone-bg: var(--bad-bg); --tone-line: var(--bad-line); }
    .overview-main { display: flex; align-items: center; gap: 16px; min-width: 0; }
    .overview-icon {
      flex: none;
      display: grid;
      place-items: center;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: var(--tone);
      color: var(--bg);
    }
    .overview-icon svg { width: 26px; height: 26px; display: block; }
    .overview-text { min-width: 0; }
    .overview-text h2 { font-size: 20px; line-height: 1.25; font-weight: 700; color: var(--tone); }
    .overview-text p { margin-top: 2px; color: var(--text); overflow-wrap: anywhere; }
    .counts { display: flex; gap: 8px; align-self: center; }
    .count {
      min-width: 92px;
      padding: 8px 12px;
      border: 1px solid var(--tone-line);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--surface) 70%, transparent);
    }
    .count dt { color: var(--muted); font-size: 12px; }
    .count dd { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.3; }
    .count.ok dd { color: var(--ok); }
    .count.alert dd { color: var(--bad); }
    .tally { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; }
    .tally-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 0 12px 0 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface);
      color: var(--text);
      font: 500 13px/1 var(--font);
      cursor: pointer;
    }
    .tally-chip:hover:not(:disabled) { border-color: var(--muted); }
    .tally-chip i { width: 9px; height: 9px; border-radius: 50%; background: var(--idle); flex: none; }
    .tally-chip.ok i { background: var(--ok); }
    .tally-chip.warn i { background: var(--warn); }
    .tally-chip.off i { background: var(--bad); }
    .tally-chip em { font-style: normal; color: var(--muted); font-size: 12px; }
    .stack-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; padding-top: 14px; border-top: 1px solid var(--tone-line); align-items: center; }
    .stack-actions .label { color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin-right: 4px; }

    .action-readout {
      padding: 10px 14px;
      border: 1px solid var(--line);
      border-left: 3px solid var(--accent);
      border-radius: var(--radius-sm);
      background: var(--surface);
      overflow-wrap: anywhere;
    }
    .action-readout:empty { display: none; }
    .action-readout.error { border-color: var(--bad-line); border-left-color: var(--bad); background: var(--bad-bg); color: var(--bad); }

    /* Sections */
    .section-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
    .section-head h2 { font-size: 15px; font-weight: 700; }
    .section-note { color: var(--muted); font-size: 12.5px; }

    /* Service cards */
    .bay { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr)); gap: 14px; }
    .svc {
      --tone: var(--idle);
      display: grid;
      gap: 14px;
      align-content: start;
      padding: 16px 18px 18px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow), inset 0 3px 0 var(--tone);
      min-width: 0;
    }
    .svc.ok { --tone: var(--ok); }
    .svc.warn { --tone: var(--warn); }
    .svc.off { --tone: var(--bad); }
    .svc.flash { animation: flash 1.2s ease-out; }
    @keyframes flash { 0% { outline: 3px solid var(--accent); outline-offset: 2px; } 100% { outline: 3px solid transparent; outline-offset: 2px; } }
    .svc-head { display: flex; align-items: flex-start; gap: 12px; justify-content: space-between; }
    .svc-title { min-width: 0; }
    .svc-title h3 { font-size: 16px; line-height: 1.3; font-weight: 700; }
    .svc-sub { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
    .badge {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 26px;
      padding: 0 11px 0 9px;
      border-radius: 999px;
      border: 1px solid var(--idle-line);
      background: var(--idle-bg);
      color: var(--idle);
      font-size: 12.5px;
      font-weight: 700;
    }
    .badge i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
    .badge.ok { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-line); }
    .badge.warn { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-line); }
    .badge.warn i { border-radius: 2px; transform: rotate(45deg); }
    .badge.off { color: var(--bad); background: var(--bad-bg); border-color: var(--bad-line); }
    .badge.off i { border-radius: 1px; }
    .svc-issue {
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      overflow-wrap: anywhere;
      background: var(--idle-bg);
      color: var(--text);
    }
    .svc.warn .svc-issue { background: var(--warn-bg); }
    .svc.off .svc-issue { background: var(--bad-bg); }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px 16px; }
    .fact { min-width: 0; }
    .fact dt { color: var(--muted); font-size: 12px; }
    .fact dd { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .svc-ops { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 14px; border-top: 1px solid var(--line); }
    .svc-ops .spacer { flex: 1 1 auto; }
    .mode-switch { display: inline-flex; gap: 0; margin-right: auto; }
    .mode-switch .button { border-radius: 0; margin-left: -1px; }
    .mode-switch .button:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); margin-left: 0; }
    .mode-switch .button:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }

    /* Panels */
    .panel { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); min-width: 0; }
    .panel-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--line); }
    .panel-head h3 { font-size: 14px; font-weight: 700; }
    .panel-head .path-chip { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    .panel-body { padding: 16px; }
    .bench { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 14px; align-items: start; }

    /* Live output */
    .log-panel { overflow: hidden; }
    .log-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--line); }
    .log-head h3 { font-size: 14px; font-weight: 700; }
    .live-state { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12.5px; font-weight: 600; }
    .live-state-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); }
    .live-state.live { color: var(--ok); }
    .live-state.live .live-state-dot { background: var(--ok); }
    .live-state.syncing .live-state-dot { background: var(--accent); }
    .live-state.paused { color: var(--warn); }
    .live-state.paused .live-state-dot { background: var(--warn); }
    .live-state.error { color: var(--bad); }
    .live-state.error .live-state-dot { background: var(--bad); }
    .chan-tabs { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 3px; border-radius: 9px; background: var(--surface-2); border: 1px solid var(--line); }
    .chan-tab {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 28px;
      padding: 0 11px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font: 600 13px/1 var(--font);
      cursor: pointer;
    }
    .chan-tab:hover:not(:disabled) { color: var(--text); }
    .chan-tab:disabled { opacity: .5; cursor: not-allowed; }
    .chan-tab.active { background: var(--surface); color: var(--text); box-shadow: 0 0 0 1px var(--line-strong); }
    .tab-led { width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); }
    .chan-tab.is-online .tab-led { background: var(--ok); }
    .rec-controls { margin-left: auto; display: flex; gap: 8px; align-items: center; }
    .rate-switch { display: inline-flex; }
    .rate-switch .button { border-radius: 0; margin-left: -1px; min-height: 30px; }
    .rate-switch .button:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); margin-left: 0; }
    .rate-switch .button:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
    .rec-controls > .button { min-height: 30px; }

    .log {
      height: 340px;
      overflow: auto;
      background: #0b0e13;
      color: #d6dce6;
      font: 12.5px/1.55 var(--mono);
      overscroll-behavior: contain;
    }
    .stream + .stream { border-top: 1px solid #232a35; }
    .stream-gutter {
      position: sticky;
      top: 0;
      display: flex;
      gap: 10px;
      align-items: baseline;
      padding: 5px 14px;
      background: #121720;
      border-bottom: 1px solid #232a35;
      z-index: 1;
    }
    .stream-name { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: .06em; color: #9db4ff; }
    .stream-stderr .stream-name { color: #ffb36b; }
    .stream-file { color: #7d8797; font-size: 11.5px; overflow-wrap: anywhere; }
    .stream-body { margin: 0; padding: 8px 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
    .stream-line { display: block; padding: 0 14px; }
    .stream-line:hover { background: #151b25; }
    .line-warn { color: #f2c46d; }
    .line-err { color: #ff8b90; background: rgba(255, 90, 100, .08); }
    .log-empty { display: grid; place-content: center; gap: 4px; height: 100%; padding: 24px; text-align: center; color: #a5afbf; }
    .log-empty-sub { font-size: 12px; color: #6f7a8b; }
    .log-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
    .follow-pill { padding: 1px 9px; border-radius: 999px; border: 1px solid var(--line-strong); font-size: 12px; font-weight: 600; }
    .follow-pill.on { color: var(--ok); border-color: var(--ok-line); background: var(--ok-bg); }
    .output-meta { overflow-wrap: anywhere; }
    .log-paths { margin-left: auto; font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; }

    /* Database list */
    .ledger { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0; }
    .ledger dt, .ledger dd { padding: 9px 0; border-bottom: 1px solid var(--line); }
    .ledger dt { color: var(--muted); padding-right: 16px; }
    .ledger dd { text-align: right; font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
    .ledger dt:nth-last-of-type(1), .ledger dd:last-of-type { border-bottom: 0; }
    .ledger dd.good { color: var(--ok); font-weight: 700; }
    .ledger dd.bad { color: var(--bad); font-weight: 700; }

    /* Credentials */
    .cred-desc { color: var(--muted); margin-bottom: 14px; }
    .cred-grid { display: grid; gap: 16px; }
    .field-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
    .field label { font-weight: 600; }
    .cred-state { padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--idle-bg); color: var(--idle); font-family: var(--mono); }
    .cred-state.configured { background: var(--ok-bg); color: var(--ok); }
    .cred-state.inherited { background: var(--warn-bg); color: var(--warn); }
    .input-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .cred-input {
      flex: 1 1 200px;
      min-width: 0;
      min-height: 34px;
      padding: 0 10px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius-sm);
      background: var(--surface);
      color: var(--text);
      font: 13px var(--mono);
    }
    .cred-input:disabled { opacity: .5; }
    .cred-input[aria-invalid="true"] { border-color: var(--bad); }
    .field-help { margin-top: 6px; color: var(--muted); font-size: 12.5px; }
    .share { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-weight: 400 !important; }
    .form-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }
    .form-foot p { flex: 1 1 260px; color: var(--muted); font-size: 12.5px; }

    .foot { color: var(--muted); font-size: 12.5px; }
    .foot-meta { display: flex; flex-wrap: wrap; gap: 4px 20px; }
    .foot-meta div { display: flex; gap: 6px; }
    .foot-meta dd { font-family: var(--mono); color: var(--text); }

    /* Dialog + toast */
    .action-dialog { width: min(420px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); color: var(--text); box-shadow: 0 24px 60px rgba(0, 0, 0, .3); }
    .action-dialog::backdrop { background: rgba(10, 12, 18, .55); }
    .action-dialog form { padding: 20px; display: grid; gap: 12px; }
    .action-dialog h2 { font-size: 17px; }
    .dlg-body { color: var(--muted); }
    .dlg-ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 24px;
      max-width: min(480px, calc(100vw - 32px));
      padding: 10px 16px;
      border-radius: var(--radius-sm);
      background: var(--text);
      color: var(--bg);
      font-weight: 500;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
      transform: translate(-50%, 16px);
      opacity: 0;
      pointer-events: none;
      transition: opacity .18s, transform .18s;
      z-index: 30;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }

    @media (max-width: 900px) {
      .bench { grid-template-columns: minmax(0, 1fr); }
      .overview { grid-template-columns: minmax(0, 1fr); }
      .counts { flex-wrap: wrap; }
    }
    @media (max-width: 560px) {
      .app { padding: 16px 12px 32px; gap: 16px; }
      h1 { font-size: 21px; }
      .overview { padding: 16px; }
      .overview-icon { width: 40px; height: 40px; }
      .overview-text h2 { font-size: 17px; }
      .count { flex: 1 1 0; min-width: 0; }
      .stack-actions .button { flex: 1 1 calc(50% - 8px); }
      .stack-actions .label { flex-basis: 100%; }
      .svc { padding: 14px; }
      .svc-ops .button { flex: 1 1 auto; }
      .mode-switch { flex: 1 1 100%; }
      .mode-switch .button { flex: 1 1 0; }
      .log { height: 260px; font-size: 12px; }
      .rec-controls { margin-left: 0; width: 100%; justify-content: space-between; }
      .chan-tabs { width: 100%; }
      .chan-tab { flex: 1 1 0; justify-content: center; padding: 0 6px; }
      .log-paths { margin-left: 0; }
    }
    @media (pointer: coarse) {
      .button, .chan-tab, .tally-chip, .cred-input { min-height: 42px; }
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
  <div class="progress" aria-hidden="true"></div>
  <main id="managerApp" class="app" aria-busy="false">
    <header class="topbar">
      <div class="brand">
        <p class="eyebrow">MMVB · Local stack</p>
        <h1>Service Manager</h1>
      </div>
      <div class="sync" id="syncState" data-state="connecting" role="status" aria-live="polite">
        <span class="sync-dot" aria-hidden="true"></span>
        <span id="syncText">Connecting...</span>
      </div>
      <button class="button" type="button" id="refreshButton">Refresh</button>
    </header>

    <section class="overview" id="overview" data-tone="pending" aria-labelledby="overviewTitle">
      <div class="overview-main">
        <span class="overview-icon" id="overviewIcon" aria-hidden="true"></span>
        <div class="overview-text">
          <h2 id="overviewTitle">Checking services...</h2>
          <p id="overviewDetail">Reading the current state of the local stack.</p>
        </div>
      </div>
      <dl class="counts" id="summary" aria-label="Stack status overview">
        <div class="count" id="sumRunning"><dt>Running</dt><dd class="record-value">—</dd></div>
        <div class="count" id="sumHealthy"><dt>Healthy</dt><dd class="record-value">—</dd></div>
        <div class="count" id="sumStopped"><dt>Stopped</dt><dd class="record-value">—</dd></div>
      </dl>
      <div class="tally" id="tally" aria-label="Service status — select to jump to its card"></div>
      <div class="stack-actions" role="group" aria-label="Full stack controls">
        <span class="label">Whole stack</span>
        <button class="button primary" type="button" data-stack="start-all">Start all</button>
        <button class="button warn" type="button" data-stack="restart-all">Restart all</button>
        <button class="button danger" type="button" data-stack="stop-all">Stop all</button>
      </div>
    </section>

    <p class="action-readout" id="actionReadout" role="status" aria-live="polite"></p>

    <section aria-labelledby="servicesTitle">
      <div class="section-head">
        <h2 id="servicesTitle">Services</h2>
        <span class="section-note">Checked every 2 s</span>
      </div>
      <div class="bay" id="cards" aria-label="Managed services"></div>
    </section>

    <section class="panel log-panel" id="outputMonitor" aria-label="Live output monitor">
      <header class="log-head">
        <h3>Live output</h3>
        <span class="live-state" id="liveLogState"><span class="live-state-dot" aria-hidden="true"></span><span id="liveLogStateText">Idle</span></span>
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
      <div class="log" id="log" role="region" aria-label="Live service output" aria-live="off" tabindex="0">
        <div class="log-empty"><p>Loading Web output</p><p class="log-empty-sub">Connecting to the live output buffer...</p></div>
      </div>
      <footer class="log-foot">
        <span class="follow-pill on" id="followPill" title="Auto-scrolling to newest output">Follow</span>
        <p class="output-meta" id="liveLogMeta" role="status" aria-live="polite">Waiting for a log source.</p>
        <p class="log-paths" id="logPaths"></p>
      </footer>
    </section>

    <div class="bench">
      <section class="panel" aria-label="Publishing credentials">
        <header class="panel-head">
          <h3>Publishing credentials</h3>
          <span class="path-chip" id="tokenPath">apps/api/.env</span>
        </header>
        <div class="panel-body">
          <p class="cred-desc">Existing values stay hidden. Each save restarts the Upload API so changes take effect immediately.</p>
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
              <p>Token text is never returned to this page. The short code beside each status is a one-way fingerprint of the active credential.</p>
              <button class="button primary" type="submit" id="saveTokensButton">Save tokens &amp; restart API</button>
            </div>
          </form>
        </div>
      </section>

      <aside class="panel" aria-label="Database">
        <header class="panel-head">
          <h3>Database</h3>
          <span class="path-chip">PostgreSQL</span>
        </header>
        <div class="panel-body">
          <dl class="ledger" id="databaseMeta"></dl>
        </div>
      </aside>
    </div>

    <footer class="foot">
      <dl class="foot-meta" id="managerMeta" aria-label="Manager runtime"></dl>
    </footer>
  </main>

  <dialog id="actionDialog" class="action-dialog" aria-labelledby="actionDialogTitle" aria-describedby="actionDialogMessage">
    <form method="dialog">
      <h2 id="actionDialogTitle">Confirm service operation</h2>
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
    const MUTATION_HEADERS = {
      "Content-Type": "application/json",
      "X-Manager-CSRF": ${JSON.stringify(MANAGER_CSRF_TOKEN)}
    };
    const AUTO_REFRESH_INTERVAL_MS = 2000;
    const LOG_SOURCE_LABELS = Object.freeze({
      web: "Web",
      api: "Upload API",
      cms: "Directus CMS",
      manager: "Service Manager"
    });
    const ERROR_PATTERN = /error|fail|exception|fatal|unhandled|refused|traceback|panic|cannot find/i;
    const WARN_PATTERN = /warn|deprecat|retry|slow|pending/i;

    const managerApp = document.getElementById("managerApp");
    const tally = document.getElementById("tally");
    const cards = document.getElementById("cards");
    const managerMeta = document.getElementById("managerMeta");
    const databaseMeta = document.getElementById("databaseMeta");
    const outputMonitor = document.getElementById("outputMonitor");
    const syncState = document.getElementById("syncState");
    const syncText = document.getElementById("syncText");
    const overview = document.getElementById("overview");
    const overviewIcon = document.getElementById("overviewIcon");
    const overviewTitle = document.getElementById("overviewTitle");
    const overviewDetail = document.getElementById("overviewDetail");
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

    function issueText(item) {
      if (item.healthy) return "";
      if (item.kind === "windows-service") {
        if (!item.running) return item.error || "Windows service is " + String(item.status || "not running").toLowerCase() + ".";
        return "Service is running but the database check failed" + (item.error ? ": " + item.error : ".");
      }
      if (!item.running) return "Nothing is listening on port " + item.port + ".";
      if (item.status) return "Port " + item.port + " is open but the health check returned HTTP " + item.status + ".";
      return "Port " + item.port + " is open but the health check failed" + (item.error ? ": " + item.error : ".");
    }

    function badgeHtml(item) {
      const status = serviceState(item);
      return '<span class="badge ' + status.cls + '"><i aria-hidden="true"></i>' + esc(status.label) + '</span>';
    }

    function fact(label, value) {
      return '<div class="fact"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
    }

    function serviceCard(item) {
      const status = serviceState(item);
      const target = item.kind === "windows-service" ? item.serviceName : item.healthUrl;
      const pids = item.pids && item.pids.length ? item.pids.join(", ") : "N/A";
      let facts;
      if (item.kind === "windows-service") {
        facts = [
          fact("Service", item.serviceName),
          fact("State", item.status),
          fact("Start type", item.startType),
          fact("DB check", item.error ? "Failed" : (item.healthy ? "OK" : "N/A"))
        ];
      } else {
        facts = [
          fact("Port", item.port),
          fact("PID", pids),
          fact("HTTP", item.status || "N/A"),
          fact("Latency", item.elapsed != null ? item.elapsed + " ms" : "N/A")
        ];
        if (item.id === "web") {
          facts.push(fact("Mode", item.modeLabel), fact("Script", item.startScript));
        }
      }
      const issue = issueText(item);
      const webMode = item.id === "web"
        ? '<div class="mode-switch" role="group" aria-label="Frontend Web mode">'
          + '<button class="button ' + (item.mode === "development" ? "active" : "") + '" type="button" data-web-mode="development" aria-pressed="' + (item.mode === "development") + '">Development</button>'
          + '<button class="button ' + (item.mode === "production" ? "active" : "") + '" type="button" data-web-mode="production" aria-pressed="' + (item.mode === "production") + '">Production</button>'
          + '</div>'
        : "";
      const rebuild = item.id === "web"
        ? '<button class="button" type="button" data-action="rebuild-restart" data-id="' + esc(item.id) + '" aria-label="Build and restart ' + esc(item.name) + '">Build + Restart</button>'
        : "";
      const open = item.openUrl
        ? '<a class="button" href="' + esc(item.openUrl) + '" target="_blank" rel="noreferrer" aria-label="Open ' + esc(item.name) + '">Open</a>'
        : "";
      const logs = item.logName
        ? '<button class="button" type="button" data-log="' + esc(item.id) + '" aria-label="Watch ' + esc(item.name) + ' output">Logs</button>'
        : "";

      return '<article class="svc ' + status.cls + '" data-card="' + esc(item.id) + '" aria-labelledby="service-' + esc(item.id) + '-title">'
        + '<header class="svc-head">'
        + '<div class="svc-title"><h3 id="service-' + esc(item.id) + '-title">' + esc(item.name) + '</h3>'
        + '<p class="svc-sub">' + esc(item.category) + " · " + esc(target) + '</p></div>'
        + badgeHtml(item)
        + '</header>'
        + (issue ? '<p class="svc-issue">' + esc(issue) + '</p>' : "")
        + '<dl class="facts">' + facts.join("") + '</dl>'
        + '<div class="svc-ops">'
        + webMode
        + '<button class="button' + (item.running ? "" : " primary") + '" type="button" data-action="start" data-id="' + esc(item.id) + '" aria-label="Start ' + esc(item.name) + '">Start</button>'
        + '<button class="button warn" type="button" data-action="restart" data-id="' + esc(item.id) + '" aria-label="Restart ' + esc(item.name) + '">Restart</button>'
        + rebuild
        + '<button class="button danger" type="button" data-action="stop" data-id="' + esc(item.id) + '" aria-label="Stop ' + esc(item.name) + '">Stop</button>'
        + '<span class="spacer"></span>'
        + open
        + logs
        + '</div>'
        + '</article>';
    }

    function footField(label, value) {
      return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
    }

    function ledgerRow(label, value, tone) {
      return '<dt>' + esc(label) + '</dt><dd' + (tone ? ' class="' + tone + '"' : '') + '>' + esc(value) + '</dd>';
    }

    function renderTally(data) {
      tally.innerHTML = data.services.map((item) => {
        const status = serviceState(item);
        return '<button class="tally-chip ' + status.cls + '" type="button" data-jump="' + esc(item.id) + '" title="Jump to ' + esc(item.name) + '">'
          + '<i aria-hidden="true"></i><span>' + esc(item.name) + '</span><em>' + esc(status.label) + '</em></button>';
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

    const OVERVIEW_ICONS = Object.freeze({
      ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
      warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6v7.5M12 17.6v.4"/></svg>',
      bad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10M17 7L7 17"/></svg>'
    });

    function renderOverview(data) {
      const services = data.services;
      const total = services.length;
      const healthy = services.filter((item) => item.healthy);
      const down = services.filter((item) => !item.running);
      const degraded = services.filter((item) => item.running && !item.healthy);
      let tone;
      let title;
      let detail;
      if (healthy.length === total) {
        tone = "ok";
        title = "All services are running normally";
        detail = "Every health check passed on the last sync.";
      } else if (down.length === total) {
        tone = "bad";
        title = "The stack is stopped";
        detail = "No managed service is running. Use Start all to bring it up.";
      } else {
        tone = down.length ? "bad" : "warn";
        const problems = down.concat(degraded);
        title = problems.length + " of " + total + " services need attention";
        detail = problems.map((item) => item.name + " (" + serviceState(item).label.toLowerCase() + ")").join(" · ");
      }
      if (data.manager.activeOperation) {
        detail += " — operation in progress: " + data.manager.activeOperation;
      }
      overview.dataset.tone = tone;
      overviewIcon.innerHTML = OVERVIEW_ICONS[tone === "ok" ? "ok" : tone === "warn" ? "warn" : "bad"];
      overviewTitle.textContent = title;
      overviewDetail.textContent = detail;
    }

    function renderSummary(data) {
      const total = data.services.length;
      const running = data.services.filter((item) => item.running).length;
      const healthy = data.services.filter((item) => item.healthy).length;
      const stopped = total - running;
      setRecordCell("sumRunning", running + " / " + total, running === total ? "ok" : "");
      setRecordCell("sumHealthy", healthy + " / " + total, healthy === total ? "ok" : "");
      setRecordCell("sumStopped", String(stopped), stopped > 0 ? "alert" : "");
      renderOverview(data);
    }

    let lastSyncAt = null;
    function setSyncState(stateName, text) {
      syncState.dataset.state = stateName;
      syncText.textContent = text;
    }

    function render(data) {
      state = data;
      renderSummary(data);
      lastSyncAt = new Date(data.updatedAt);
      setSyncState("live", "Live · updated " + lastSyncAt.toLocaleTimeString());
      document.title = data.services.filter((item) => item.healthy).length + "/" + data.services.length + " healthy · Service Manager";

      renderTally(data);
      cards.innerHTML = data.services.map(serviceCard).join("");
      if (busy) cards.querySelectorAll("button").forEach((button) => { button.disabled = true; });
      updateLogControls();
      renderUploadTokens(data.uploadTokens);
      managerMeta.innerHTML = [
        footField("Manager", data.manager.host + ":" + data.manager.port),
        footField("PID", data.manager.pid),
        footField("Uptime", data.manager.uptime + "s"),
        footField("Node", data.manager.node)
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
          if (generation === statusGeneration) {
            setSyncState("offline", "Manager unreachable" + (lastSyncAt ? " · last data " + lastSyncAt.toLocaleTimeString() : ""));
          }
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
          method: "POST", headers: MUTATION_HEADERS
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
        const response = await fetch(apiPath("/api/stack/" + encodeURIComponent(action)), { method: "POST", headers: MUTATION_HEADERS });
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
          method: "POST", headers: MUTATION_HEADERS
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
          headers: MUTATION_HEADERS,
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
        button.classList.toggle("active", active && button.classList.contains("chan-tab"));
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
      updateFollowPill();
    }

    function showScreenNotice(title, sub) {
      log.replaceChildren();
      const box = document.createElement("div");
      box.className = "log-empty";
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
        showScreenNotice("Loading " + logSourceLabel(id) + " output", "Reading the latest buffered output...");
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
        showScreenNotice("Loading " + logSourceLabel(id) + " output", "Reading the latest buffered output...");
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
        if (!logButton.closest("#outputMonitor")) {
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
