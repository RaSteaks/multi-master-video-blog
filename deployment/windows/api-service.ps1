param(
  [ValidateSet("start", "stop", "restart", "status", "health")]
  [string]$Action = "status",

  [string]$ProjectRoot = "D:\multi-master-video-blog",

  [int]$Port = 8060,

  [int]$WaitSeconds = 20
)

$ErrorActionPreference = "Stop"

function Get-ApiListeners {
  Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" -and $_.OwningProcess } |
    Select-Object -ExpandProperty OwningProcess -Unique
}

function Stop-Api {
  $owners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

  if (-not $owners) {
    Write-Host "API is not listening on port $Port."
    return
  }

  foreach ($owner in $owners) {
    if ($owner -and $owner -ne 0) {
      Write-Host "Stopping API process $owner on port $Port..."
      Stop-Process -Id $owner -Force
    }
  }
}

function Start-Api {
  $listeners = Get-ApiListeners
  if ($listeners) {
    Write-Host "API is already listening on port $Port. PID: $($listeners -join ', ')"
    return
  }

  $logDir = Join-Path $ProjectRoot "logs"
  New-Item -ItemType Directory -Force $logDir | Out-Null

  $stdout = Join-Path $logDir "api.out.log"
  $stderr = Join-Path $logDir "api.err.log"

  Write-Host "Starting API on port $Port..."
  Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList @("run", "start:api") `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden

  Wait-ApiHealth
}

function Wait-ApiHealth {
  $deadline = (Get-Date).AddSeconds($WaitSeconds)

  do {
    Start-Sleep -Milliseconds 800
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
      Write-Host "API health: $($health.status)."
      return
    } catch {
      if ((Get-Date) -ge $deadline) {
        throw "API did not become healthy within $WaitSeconds seconds. Check logs/api.err.log."
      }
    }
  } while ((Get-Date) -lt $deadline)
}

function Show-ApiStatus {
  $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, State, OwningProcess |
    Sort-Object State, OwningProcess

  if (-not $connections) {
    Write-Host "API is not using port $Port."
    return
  }

  $connections | Format-Table -AutoSize
}

switch ($Action) {
  "start" {
    Start-Api
    Show-ApiStatus
  }
  "stop" {
    Stop-Api
    Show-ApiStatus
  }
  "restart" {
    Stop-Api
    Start-Sleep -Seconds 1
    Start-Api
    Show-ApiStatus
  }
  "status" {
    Show-ApiStatus
  }
  "health" {
    Wait-ApiHealth
  }
}
