const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");
const { runPowerShell, stopProcessesCommand } = require("./manager-powershell.cjs");
const windows = process.platform === "win32";

test("rejects invalid PIDs", () => {
  assert.throws(() => stopProcessesCommand([0]));
  assert.throws(() => stopProcessesCommand(["1; exit 0"]));
});

test("already exited processes succeed", { skip: !windows }, async () => {
  await runPowerShell(stopProcessesCommand([2147483647]));
});

test("exit between lookup and stop succeeds", { skip: !windows }, async () => {
  await runPowerShell([
    "$script:lookups = 0;",
    "function Get-Process { param($Id, $ErrorAction) $script:lookups++; if ($script:lookups -eq 1) { [pscustomobject]@{ Id = $Id } } };",
    "function Stop-Process { param($InputObject, [switch]$Force, $ErrorAction) throw 'Process exited' };",
    stopProcessesCommand([123])
  ].join(" "));
});

test("surviving process failure is reported", { skip: !windows }, async () => {
  await assert.rejects(runPowerShell([
    "function Get-Process { param($Id, $ErrorAction) [pscustomobject]@{ Id = $Id } };",
    "function Stop-Process { param($InputObject, [switch]$Force, $ErrorAction) throw 'Access denied' };",
    stopProcessesCommand([123])
  ].join(" ")), (error) => {
    assert.match(error.stderr, /PID 123: Access denied/);
    return true;
  });
});

test("stops a disposable child even when final PID has exited", { skip: !windows }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  const exited = once(child, "exit");
  try {
    await runPowerShell(stopProcessesCommand([child.pid, 2147483647]));
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test("UTF-8 output and errors survive redirection", { skip: !windows }, async () => {
  const expected = "\u65e0\u6cd5\u505c\u6b62\u670d\u52a1";
  const expression = "(-join (0x65e0,0x6cd5,0x505c,0x6b62,0x670d,0x52a1 | ForEach-Object { [char]$_ }))";
  assert.equal(await runPowerShell("Write-Output " + expression), expected);
  await assert.rejects(runPowerShell("throw " + expression), (error) => {
    assert.ok(error.stderr.includes(expected));
    assert.ok(!error.stderr.includes("\ufffd"));
    return true;
  });
});
