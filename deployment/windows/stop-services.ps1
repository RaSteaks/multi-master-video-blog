param(
  [int[]]$Ports = @(3000, 8055, 8060),
  [string]$ProjectRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
)
$ErrorActionPreference = "Stop"
$serviceByPort = @{ 3000 = "web"; 8055 = "cms"; 8060 = "api" }
$serviceIds = @($Ports | ForEach-Object {
  if (-not $serviceByPort.ContainsKey($_)) { throw "Unmanaged port: $_. No services were stopped." }
  $serviceByPort[$_]
} | Select-Object -Unique)
if (-not $serviceIds.Count) { return }
& node (Join-Path $ProjectRoot "scripts/service-control.cjs") processes stop @serviceIds
if ($LASTEXITCODE -ne 0) { throw "Stopping process services failed. See the errors above." }
