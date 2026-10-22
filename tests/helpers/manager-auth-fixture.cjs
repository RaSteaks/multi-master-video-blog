const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

async function startAuthFixture({ port = 0, basePath = "/manager", password = "fixture-password-only" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-auth-test-"));
  const sourcePath = path.resolve(__dirname, "../../scripts/manager-dashboard.cjs");
  const context = vm.createContext({ require: createRequire(sourcePath), module: { exports: {} },
    __dirname: path.join(root, "scripts"), process: { env: { MANAGER_AUTH_PASSWORD: password, MANAGER_BASE_PATH: basePath }, pid: process.pid },
    console, Buffer, URL, AbortSignal, fetch, setTimeout, clearTimeout });
  vm.runInContext(await fs.readFile(sourcePath, "utf8"), context);
  // Keep the actual HTTP authentication and routing. Only service/DB/log effects
  // are replaced, so tests cannot control the user's installed services.
  vm.runInContext(`
    allStatus = async () => ({ updatedAt: new Date().toISOString(),
      services: services.map(service => ({...service, running:true, healthy:true, mode:'development'})),
      manager: {host:'127.0.0.1',port:0,pid:123,node:'fixture',uptime:1}, database:{healthy:true},
      uploadTokens:{path:'fixture',tokens:[]}, operation:null });
    readServiceLogs = async id => ({serviceId:id,stdout:'',stderr:'',files:{}});
    handleAction = handleStackAction = handleWebModeChange = handleUploadTokenChange = async () => {
      throw new Error('Unexpected service mutation in authentication fixture');
    };
  `, context);
  const { server } = context.module.exports;
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  return {
    url: "http://127.0.0.1:" + server.address().port,
    basePath, password, context,
    async close() {
      await new Promise(resolve => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

if (require.main === module) startAuthFixture({ port: 8094 }).then(fixture => console.log(fixture.url + fixture.basePath));
module.exports = { startAuthFixture };
