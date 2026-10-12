const { execFile } = require("node:child_process");

function runPowerShell(command, cwd) {
  // Windows PowerShell otherwise uses the console code page for redirected output.
  const script = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false);",
    "$OutputEncoding = [Console]::OutputEncoding;",
    "$ErrorActionPreference = 'Stop';",
    command
  ].join(" ");
  return new Promise((resolve, reject) => {
    let drainTimer;
    const child = execFile("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { cwd, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        clearTimeout(drainTimer);
        if (error) {
          error.stderr = stderr.trim();
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    child.once("exit", () => {
      // Start-Process descendants can retain the PowerShell pipe handles after
      // powershell.exe has exited. Allow queued output to drain, then close only
      // our readers; the service keeps running and writing its own log files.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 250);
      drainTimer.unref();
    });
  });
}

function stopProcessesCommand(ids) {
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new Error("Invalid process ID.");
  }
  return [
    "$failures = @();",
    `foreach ($targetId in @(${ids.join(",")})) {`,
    "$targetProcess = Get-Process -Id $targetId -ErrorAction SilentlyContinue;",
    "if (-not $targetProcess) { continue };",
    "try { Stop-Process -InputObject $targetProcess -Force -ErrorAction Stop }",
    "catch {",
    "$stopError = $_;",
    // A process can exit between lookup and Stop-Process; only report survivors.
    "if (Get-Process -Id $targetId -ErrorAction SilentlyContinue) {",
    "$failures += ('PID ' + $targetId + ': ' + $stopError.Exception.Message)",
    "}",
    "}",
    "};",
    "if ($failures.Count -gt 0) { throw ($failures -join '; ') };",
    // A missing final PID must not determine powershell.exe's exit code.
    "exit 0"
  ].join(" ");
}

module.exports = { runPowerShell, stopProcessesCommand };
