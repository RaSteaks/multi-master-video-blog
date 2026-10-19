const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);

// Fault injection exercises the actual deployment script without Docker or host services.
for (const mode of ["success", "build-failure", "restart-failure", "stop-failure", "legacy-helper"]) {
  test(`Docker maintenance update: ${mode}`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-deploy-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.copyFile(path.join(__dirname, "../deployment/docker/update.sh"), path.join(dir, "update.sh"));
    await fs.writeFile(path.join(dir, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(path.join(dir, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), log = process.env.TEST_LOG;
const previous = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').map(JSON.parse) : [];
fs.appendFileSync(log, JSON.stringify(args)+'\\n');
if (args[0] === 'inspect') { console.log('sha256:'+'a'.repeat(64)); process.exit(0); }
if (args[0] === 'image') process.exit(1);
if (args.includes('ps')) { console.log('fixture-'+args.at(-1)); process.exit(0); }
const mode = process.env.TEST_MODE;
if (mode === 'legacy-helper' && args.includes('drain')) process.exit(2);
if (mode === 'build-failure' && args.includes('build') && args.at(-1) === 'api') process.exit(1);
if (mode === 'stop-failure' && args.includes('stop')) process.exit(1);
if (mode === 'restart-failure' && args.includes('up') && !previous.some(a=>a.includes('up'))) process.exit(1);
process.exit(0);
`, { mode: 0o755 });
    // Node eagerly scans --env-file in argv; terminate its option parsing before the stub.
    await fs.rename(path.join(dir, "docker"), path.join(dir, "docker.cjs"));
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await fs.writeFile(path.join(dir, "docker"), `#!/bin/sh\nexec ${quote(process.execPath)} -- ${quote(path.join(dir, "docker.cjs"))} "$@"\n`, { mode: 0o755 });
    let status = 0, diagnostics = "";
    try {
      await exec("bash", [path.join(dir, "update.sh"), "low-4gb", "fixture-release"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_MODE: mode, TEST_LOG: path.join(dir, "calls") }
      });
    } catch (error) { status = error.code; diagnostics = error.stderr; }
    assert.equal(status, mode === "success" ? 0 : mode === "legacy-helper" ? 2 : 1, diagnostics);
    const calls = (await fs.readFile(path.join(dir, "calls"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(a => a.includes("drain")));
    assert.ok(calls.at(-1).includes("off"));
    assert.ok(!calls.some(a => a.includes("down") || a.includes("prune")));
    const starts = calls.filter(a => a.includes("up"));
    if (mode === "legacy-helper") {
      assert.equal(starts.length, 0);
      assert.ok(!calls.some(a => a.includes("stop") || a.includes("build")));
    } else if (mode !== "success") {
      assert.ok(starts.at(-1).some(a => a.startsWith(os.tmpdir()) || a.startsWith("/tmp/")));
      assert.ok(starts.at(-1).includes("--no-build"));
    } else {
      assert.deepEqual(calls.filter(a => a.includes("build")).map(a => a.at(-1)), ["cms", "api", "web"]);
      const rollback = JSON.parse(await fs.readFile(path.join(dir, "rollback-fixture-release.json")));
      assert.equal(rollback.services.api.image, "sha256:" + "a".repeat(64));
      assert.equal(await fs.readFile(path.join(dir, ".release.env"), "utf8"), "RELEASE_TAG=fixture-release\n");
      assert.equal(await fs.readFile(path.join(dir, "rollback-fixture-release.env"), "utf8"), "RELEASE_TAG=local\n");
    }
  });
}

for (const profile of ["low-2gb", "low-4gb"]) {
  test(`Compose resolves ${profile} with HTTPS/Vulkan and private backends`, async t => {
    try { await exec("docker", ["compose", "version"]); }
    catch (error) { if (error.code === "ENOENT") return t.skip("Docker CLI not installed"); throw error; }
    const { stdout } = await exec("docker", ["compose", "--env-file", "/dev/null",
      "-f", "deployment/docker/compose.yaml", "-f", `deployment/docker/compose.${profile}.yaml`,
      "-f", "deployment/docker/compose.https.yaml", "-f", "deployment/docker/compose.vulkan.yaml",
      "--profile", "setup", "config", "--format", "json"], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, DB_PASSWORD: "fixture", DIRECTUS_KEY: "fixture", DIRECTUS_SECRET: "fixture",
        ADMIN_EMAIL: "fixture@example.invalid", ADMIN_PASSWORD: "fixture", SERVICE_EMAIL: "fixture@example.invalid",
        SERVICE_PASSWORD: "fixture", UPLOAD_API_TOKEN: "fixture", ARTICLE_API_TOKEN: "fixture", REVALIDATE_SECRET: "fixture",
        TLS_CERT_DIR: "/tmp/fixture-certs", RENDER_GID: "109", PUBLIC_URL: "https://example.invalid:8443" }
    });
    const { services } = JSON.parse(stdout);
    for (const name of ["api", "web", "cms", "db"]) assert.equal(services[name].ports, undefined);
    for (const name of ["api", "web", "cms", "schema", "bootstrap"]) assert.equal(services[name].environment.RESOURCE_PROFILE, profile);
    // Public traffic must pass through the API's private-path checks.
    assert.ok(!services.nginx.volumes.some(v => ["media", "private-media"].includes(v.source)));
    assert.equal(services.api.volumes.find(v => v.source === "private-media").target, "/app/.private-media");
    const routes = await fs.readFile(path.join(__dirname, "../deployment/nginx/blog-routes.conf"), "utf8");
    assert.doesNotMatch(routes, /^\s*alias\s/m);
    assert.match(routes, /location \/media\/ \{[\s\S]*?proxy_pass http:\/\/blog_api;/);
    assert.equal(services.api.privileged, undefined);
    assert.equal(services.web.build.args.DIRECTUS_URL, "http://cms:8055");
    assert.equal(services.web.build.args.DIRECTUS_PASSWORD, undefined);
    assert.ok(services.db.image.includes("@sha256:"));
    assert.ok(services.nginx.image.includes("@sha256:"));
  });
}
