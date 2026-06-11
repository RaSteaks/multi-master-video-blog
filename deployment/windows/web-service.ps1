param(
  [ValidateSet("start", "stop", "restart", "rebuild-restart", "status", "health")]
  [string]$Action = "status",

  [string]$ProjectRoot = "D:\multi-master-video-blog",

  [int]$Port = 3000,

  [int]$WaitSeconds = 30,

  [string]$NpmScript = "dev:web"
)

$ErrorActionPreference = "Stop"

function Get-WebListeners {
  Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" -and $_.OwningProcess } |
    Select-Object -ExpandProperty OwningProcess -Unique
}

function Stop-Web {
  $owners = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

  if (-not $owners) {
    Write-Host "Web is not listening on port $Port."
    return
  }

  foreach ($owner in $owners) {
    if ($owner -and $owner -ne 0) {
      Write-Host "Stopping Web process $owner on port $Port..."
      Stop-Process -Id $owner -Force
    }
  }
}

function Build-Web {
  Write-Host "Building Web..."
  Push-Location $ProjectRoot
  try {
    npm run build:web
  } finally {
    Pop-Location
  }
}

function Start-Web {
  $listeners = Get-WebListeners
  if ($listeners) {
    Write-Host "Web is already listening on port $Port. PID: $($listeners -join ', ')"
    return
  }

  $logDir = Join-Path $ProjectRoot "logs"
  New-Item -ItemType Directory -Force $logDir | Out-Null

  $stdout = Join-Path $logDir "web.out.log"
  $stderr = Join-Path $logDir "web.err.log"

  Write-Host "Starting Web in development mode on port $Port..."
  Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList @("run", $NpmScript) `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden

  Wait-WebHealth
}

function Wait-WebHealth {
  $deadline = (Get-Date).AddSeconds($WaitSeconds)

  do {
    Start-Sleep -Milliseconds 800
    try {
      $response = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        Write-Host "Web health: HTTP $($response.StatusCode)."
        return
      }
    } catch {
      if ((Get-Date) -ge $deadline) {
        throw "Web did not become healthy within $WaitSeconds seconds. Check logs/web.err.log."
      }
    }
  } while ((Get-Date) -lt $deadline)
}

function Show-WebStatus {
  $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, State, OwningProcess |
    Sort-Object State, OwningProcess

  if (-not $connections) {
    Write-Host "Web is not using port $Port."
    return
  }

  $connections | Format-Table -AutoSize
}

switch ($Action) {
  "start" {
    Start-Web
    Show-WebStatus
  }
  "stop" {
    Stop-Web
    Show-WebStatus
  }
  "restart" {
    Stop-Web
    Start-Sleep -Seconds 1
    Start-Web
    Show-WebStatus
  }
  "rebuild-restart" {
    if ($NpmScript -eq "dev:web") {
      Write-Host "Development mode does not require a production build."
    } else {
      Build-Web
    }
    Stop-Web
    Start-Sleep -Seconds 1
    Start-Web
    Show-WebStatus
  }
  "status" {
    Show-WebStatus
  }
  "health" {
    Wait-WebHealth
  }
}
