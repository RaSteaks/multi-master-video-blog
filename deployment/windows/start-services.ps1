param(
  [string]$ProjectRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)
$ErrorActionPreference = "Stop"
& node (Join-Path $ProjectRoot "scripts/service-control.cjs") stack start-all
if ($LASTEXITCODE -ne 0) { throw "start-all failed. See the service errors above." }
