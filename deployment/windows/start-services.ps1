param(
  [string]$ProjectRoot = "D:\multi-master-video-blog"
)

$ErrorActionPreference = "Stop"

function Start-BlogService {
  param(
    [string]$Name,
    [string[]]$Arguments
  )

  $logDir = Join-Path $ProjectRoot "logs"
  New-Item -ItemType Directory -Force $logDir | Out-Null

  $stdout = Join-Path $logDir "$Name.out.log"
  $stderr = Join-Path $logDir "$Name.err.log"

  Start-Process `
    -FilePath "npm.cmd" `
    -ArgumentList $Arguments `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden
}

Start-BlogService -Name "web" -Arguments @("run", "start:web")
Start-BlogService -Name "cms" -Arguments @("run", "start:cms")
Start-BlogService -Name "api" -Arguments @("run", "start:api")

Write-Host "Services started. Run npm run health after a few seconds."
