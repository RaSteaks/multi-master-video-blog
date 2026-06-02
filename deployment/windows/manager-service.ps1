param(
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Action = "status",

  [string]$ProjectRoot = "D:\multi-master-video-blog",

  [int]$Port = 8070
)

$ErrorActionPreference = "Stop"

function Get-ManagerOwners {
  Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" -and $_.OwningProcess } |
    Select-Object -ExpandProperty OwningProcess -Unique
}

function Stop-Manager {
  $owners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

  if (-not $owners) {
    Write-Host "Manager is not listening on port $Port."
    return
  }

  foreach ($owner in $owners) {
    if ($owner -and $owner -ne 0) {
      Write-Host "Stopping manager process $owner on port $Port..."
      Stop-Process -Id $owner -Force
    }
  }
}

function Start-Manager {
  $owners = Get-ManagerOwners
  if ($owners) {
    Write-Host "Manager is already listening on port $Port. PID: $($owners -join ', ')"
    return
  }

  $logDir = Join-Path $ProjectRoot "logs"
  New-Item -ItemType Directory -Force $logDir | Out-Null

  Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList @("run", "manager") `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput (Join-Path $logDir "manager.out.log") `
    -RedirectStandardError (Join-Path $logDir "manager.err.log") `
    -WindowStyle Hidden

  Start-Sleep -Seconds 2
  Show-ManagerStatus
}

function Show-ManagerStatus {
  $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, State, OwningProcess |
    Sort-Object State, OwningProcess

  if (-not $connections) {
    Write-Host "Manager is not using port $Port."
    return
  }

  $connections | Format-Table -AutoSize
}

switch ($Action) {
  "start" { Start-Manager }
  "stop" { Stop-Manager; Show-ManagerStatus }
  "restart" { Stop-Manager; Start-Sleep -Seconds 1; Start-Manager }
  "status" { Show-ManagerStatus }
}
