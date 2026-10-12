param(
  [ValidateSet("start", "stop", "restart", "rebuild-restart", "status", "health")]
  [string]$Action = "status",
  [string]$ProjectRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
  [int]$Port = 8060,
  [int]$WaitSeconds = 30
)
$ErrorActionPreference = "Stop"
if ($Port -ne 8060) { throw "The api service is configured for port 8060. Custom ports are not supported by its npm script." }
$previousWait = $env:MANAGER_WAIT_MS

try {
  $env:MANAGER_WAIT_MS = [string]($WaitSeconds * 1000)

  & node (Join-Path $ProjectRoot "scripts/service-control.cjs") api $Action
  if ($LASTEXITCODE -ne 0) { throw "api $Action failed. See the error above and logs/api.err.log." }
} finally {
  $env:MANAGER_WAIT_MS = $previousWait

}
