const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { test } = require('node:test');
const script = path.resolve(__dirname,'../deployment/windows/manager-service.ps1');

test('Manager launcher start, restart, stop and early failure on an isolated port', {skip:process.platform!=='win32', timeout:90000}, async()=>{
 const root=await fs.mkdtemp(path.resolve(__dirname,'../tmp/manager-launch-'));
 await fs.mkdir(path.join(root,'scripts'));
 const fake=path.join(root,'scripts/manager-dashboard.cjs');
 await fs.writeFile(fake, `const http=require('node:http');http.createServer((q,s)=>s.end('fixture')).listen(Number(process.env.MANAGER_PORT),'127.0.0.1');`);
 const invoke=(action)=>exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,action,'-ProjectRoot',root,'-Port','18071','-WaitSeconds','8'],{windowsHide:true,timeout:25000});
 try {
  const first=await invoke('start');
  assert.match(first.stdout,/Manager started/);
  const firstPid=first.stdout.match(/PID: (\d+)/)[1];
  assert.equal(await (await fetch('http://127.0.0.1:18071')).text(),'fixture');
  assert.match((await invoke('start')).stdout,/already listening/);
  const restarted=await invoke('restart');
  assert.match(restarted.stdout,/Manager started/);
  assert.notEqual(restarted.stdout.match(/PID: (\d+)/)[1],firstPid);
  assert.match((await invoke('stop')).stdout,/not listening/);
  assert.match((await invoke('stop')).stdout,/not listening/);
  await fs.writeFile(fake,'process.exit(7)');
  await assert.rejects(invoke('start'),e=>{assert.match(e.stderr,/exited during startup/);return true;});
 } finally {await invoke('stop').catch(()=>{});}
});
