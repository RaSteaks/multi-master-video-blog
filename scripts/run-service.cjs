const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { loadEnvironment, resolveResourceProfile } = require("../config/resource-profile.cjs");

// One launcher applies identical budgets to native services and Docker images.
const root = path.resolve(__dirname, "..");
const service = process.argv[2];
const directories = { api: "apps/api", web: "apps/web", build: "apps/web", cms: "apps/cms/directus", schema: "apps/cms/directus", bootstrap: "apps/cms/directus" };
if (!directories[service]) throw new Error("Expected api, web, build, cms, bootstrap or schema.");
const cwd = process.env.SERVICE_CWD || path.join(root, directories[service]);
const env = loadEnvironment(path.join(cwd, ".env"));
const settings = resolveResourceProfile(env);
const heap = settings.heap[["bootstrap", "schema"].includes(service) ? "cms" : service];
if (settings.enabled) {
  env.DB_POOL__MIN ??= String(settings.dbPoolMin);
  env.DB_POOL__MAX ??= String(settings.dbPoolMax);
  env.ASSETS_TRANSFORM_MAX_CONCURRENT ??= String(settings.assetConcurrency);
  env.UV_THREADPOOL_SIZE ??= "2";
  env.MALLOC_ARENA_MAX ??= "2";
  env.VIPS_CONCURRENCY ??= String(settings.sharpConcurrency || 1);
  // Mesa software Vulkan has its own pool independent of FFmpeg codec threads.
  env.LP_NUM_THREADS ??= String(settings.ffmpegThreads || 1);
}
env.NODE_ENV ||= "production";
const resolve = id => require.resolve(id, { paths: [cwd, root] });
let args;
if (service === "api") args = [path.join(root, "apps/api/src/server.cjs")];
else if (service === "schema") args = [path.join(root, "scripts/setup-directus-schema.cjs")];
else if (["cms", "bootstrap"].includes(service)) {
  const cli = process.env.DIRECTUS_CLI || path.join(path.dirname(resolve("directus/package.json")), "cli.js");
  args = [cli, service === "bootstrap" ? "bootstrap" : "start"];
} else if (service === "web" && fs.existsSync(path.join(cwd, "server.js"))) args = [path.join(cwd, "server.js")];
else args = [resolve("next/dist/bin/next"), ...(service === "build" ? ["build"] : ["start", "-H", env.HOST || "127.0.0.1", "-p", env.PORT || "3000"])];
// Wait for CMS readiness before API queue recovery or server-side web requests.
// A bounded startup wait also works with systemd's non-readiness-aware ordering.
let child;
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  stopping = true;
  if (child) child.kill(signal);
  else process.exitCode = 1;
});
async function start() {
  if (["api", "web", "schema"].includes(service)) {
    const deadline = Date.now() + 180000;
    const url = `${(env.DIRECTUS_URL || "http://127.0.0.1:8055").replace(/\/$/, "")}/server/health`;
    while (!stopping) {
      try { const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
        if (response.ok) break;
      } catch { /* CMS may still be booting or unavailable briefly after restart. */ }
      if (Date.now() >= deadline) throw new Error("CMS did not become healthy within 180 seconds.");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  if (stopping) return;
  // Preserve unrelated NODE_OPTIONS; explicit heap flags win over its heap setting.
  child = spawn(process.execPath, [...(heap ? [`--max-old-space-size=${heap}`] : []), ...args], { cwd, env, stdio: "inherit" });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
start().catch(error => { console.error(error.message); process.exitCode = 1; });
