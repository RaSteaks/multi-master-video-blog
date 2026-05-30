param(
  [int[]]$Ports = @(3000, 8055, 8060)
)

$ErrorActionPreference = "Stop"

foreach ($port in $Ports) {
  $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue

  foreach ($connection in $connections) {
    if ($connection.OwningProcess) {
      Write-Host "Stopping port $port process $($connection.OwningProcess)"
      Stop-Process -Id $connection.OwningProcess -Force
    }
  }
}
