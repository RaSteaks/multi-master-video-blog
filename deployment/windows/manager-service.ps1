param(
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Action = "status",
  [string]$ProjectRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
  [int]$Port = 0,
  [int]$WaitSeconds = 20
)
$ErrorActionPreference = "Stop"
# Resolve the same configured port as the Node manager, without exposing credentials.
if (-not $Port) {
  $configPath = Join-Path $ProjectRoot "scripts/manager-dashboard.cjs"
  $portText = & node -e "console.log(require(process.argv[1]).managerStatus().port)" $configPath
  if ($LASTEXITCODE -ne 0) { throw "Could not read Manager configuration." }
  $Port = [int]$portText
}
function Get-ManagerOwners {
  @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" -and $_.OwningProcess } |
    Select-Object -ExpandProperty OwningProcess -Unique)
}
function Assert-ManagerOwner($OwnerId) {
  $item = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerId"
  if (-not $item -or $item.CommandLine -notmatch 'manager-dashboard\.cjs') {
    throw "Port $Port is occupied by a different or inaccessible process ($OwnerId). Refusing to stop it or report Manager ready."
  }
}
function Stop-Manager {
  $owners = Get-ManagerOwners
  foreach ($owner in $owners) {
    Assert-ManagerOwner $owner
    try { Stop-Process -Id $owner -Force -ErrorAction Stop }
    catch {
      if (Get-Process -Id $owner -ErrorAction SilentlyContinue) {
        throw "Could not stop Manager PID $owner. Use an Administrator PowerShell. $($_.Exception.Message)"
      }
    }
  }
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while (Get-ManagerOwners) {
    if ((Get-Date) -ge $deadline) { throw "Manager did not release port $Port." }
    Start-Sleep -Milliseconds 250
  }
}
function Start-Manager {
  $owners = Get-ManagerOwners
  if ($owners) {
    foreach ($owner in $owners) { Assert-ManagerOwner $owner }
    Write-Host "Manager is already listening on port $Port."
    return
  }
  $logDir = Join-Path $ProjectRoot "logs"
  New-Item -ItemType Directory -Force $logDir | Out-Null
  $previousPort = $env:MANAGER_PORT
  try {
    $env:MANAGER_PORT = [string]$Port
    $child = Start-Process -FilePath "node.exe" `
      -ArgumentList @('"' + (Join-Path $ProjectRoot "scripts/manager-dashboard.cjs") + '"') `
      -WorkingDirectory $ProjectRoot `
      -RedirectStandardOutput (Join-Path $logDir "manager.out.log") `
      -RedirectStandardError (Join-Path $logDir "manager.err.log") `
      -WindowStyle Hidden -PassThru
  } finally { $env:MANAGER_PORT = $previousPort }
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  do {
    if ($child.HasExited) { throw "Manager exited during startup. Check logs/manager.err.log." }
    $owners = Get-ManagerOwners
    if ($owners -contains $child.Id) {
      Write-Host "Manager started on port $Port. PID: $($child.Id)"
      return
    }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $deadline)
  if (-not $child.HasExited) { Stop-Process -InputObject $child -Force }
  throw "Manager did not listen on port $Port within $WaitSeconds seconds. Check logs/manager.err.log."
}
function Show-ManagerStatus {
  $owners = Get-ManagerOwners
  if (-not $owners) { Write-Host "Manager is not listening on port $Port."; return }
  foreach ($owner in $owners) { Assert-ManagerOwner $owner }
  Write-Host "Manager is listening on port $Port. PID: $($owners -join ', ')"
}
switch ($Action) {
  "start" { Start-Manager }
  "stop" { Stop-Manager; Show-ManagerStatus }
  "restart" { Stop-Manager; Start-Manager }
  "status" { Show-ManagerStatus }
}
