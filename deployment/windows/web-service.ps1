param(
  [ValidateSet("start", "stop", "restart", "rebuild-restart", "status", "health")]
  [string]$Action = "status",
  [string]$ProjectRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
  [int]$Port = 3000,
  [int]$WaitSeconds = 30,
  [ValidateSet("", "dev:web", "start:web")]
  [string]$NpmScript = ""
)
$ErrorActionPreference = "Stop"
if ($Port -ne 3000) { throw "The web service is configured for port 3000. Custom ports are not supported by its npm script." }
$previousWait = $env:MANAGER_WAIT_MS
$previousMode = $env:MANAGER_WEB_MODE
try {
  $env:MANAGER_WAIT_MS = [string]($WaitSeconds * 1000)
  if ($NpmScript) { $env:MANAGER_WEB_MODE = if ($NpmScript -eq "start:web") { "production" } else { "development" } }
  & node (Join-Path $ProjectRoot "scripts/service-control.cjs") web $Action
  if ($LASTEXITCODE -ne 0) { throw "web $Action failed. See the error above and logs/web.err.log." }
} finally {
  $env:MANAGER_WAIT_MS = $previousWait
  $env:MANAGER_WEB_MODE = $previousMode
}
