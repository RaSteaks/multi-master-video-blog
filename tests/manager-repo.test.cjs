const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { createRepoUpdater } = require("../scripts/manager-repo.cjs");

function sandbox(t) {
  // Real Git against local repositories only; global and system configuration
  // (signing, hooks, credential helpers) cannot leak into the fixture.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-repo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const globalConfig = path.join(dir, "gitconfig");
  fs.writeFileSync(globalConfig, "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const write = (root, file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  const remote = path.join(dir, "origin.git");
  const author = path.join(dir, "author");
  const checkout = path.join(dir, "checkout");
  git(dir, "init", "--bare", "--quiet", remote);
  git(dir, "clone", "--quiet", remote, author);
  for (const file of ["apps/api/src/server.cjs", "apps/web/src/page.tsx", "scripts/manager-dashboard.cjs", "deployment/docker/compose.yaml", "README.md"]) {
    write(author, file, "initial " + file + "\n");
  }
  git(author, "add", ".");
  git(author, "commit", "--quiet", "-m", "Initial");
  git(author, "push", "--quiet", "origin", "HEAD:main");
  git(dir, "clone", "--quiet", remote, checkout);
  const publish = (files, message = "Upstream change", ...pushOptions) => {
    for (const [file, content] of Object.entries(files)) write(author, file, content);
    git(author, "add", ".");
    git(author, "commit", "--quiet", "-m", message);
    git(author, "push", "--quiet", ...pushOptions, "origin", "HEAD:main");
    return git(author, "rev-parse", "HEAD");
  };
  const updater = (options = {}) => createRepoUpdater({
    root: checkout, execFile, env, platform: process.platform,
    loadedFiles: () => ["scripts/manager-dashboard.cjs"], ...options
  });
  return { dir, env, git, write, author, checkout, publish, updater };
}

test("reports an up-to-date checkout and a directory that is not a repository", async t => {
  const fixture = sandbox(t);
  const repo = await fixture.updater().status();
  assert.equal(repo.available, true);
  assert.equal(repo.branch, "main");
  assert.equal(repo.upstream, "origin/main");
  assert.equal(repo.behind, 0);
  assert.equal(repo.head.subject, "Initial");
  const plain = await createRepoUpdater({ root: fixture.dir, execFile, env: fixture.env }).status();
  assert.equal(plain.available, false);
  assert.match(plain.error, /not running from a Git checkout|not .*Git working tree/);
});

test("fetch reveals incoming commits and the services they affect without changing the checkout", async t => {
  const fixture = sandbox(t);
  const before = fixture.git(fixture.checkout, "rev-parse", "HEAD");
  fixture.publish({ "apps/api/src/server.cjs": "api v2\n", "scripts/manager-dashboard.cjs": "manager v2\n" }, "Change API and Manager");
  const repo = fixture.updater();
  const result = await repo.fetch();
  assert.match(result.message, /origin\/main has 1 commit that main does not/);
  const status = await repo.status();
  assert.equal(status.behind, 1);
  assert.equal(status.incoming[0].subject, "Change API and Manager");
  assert.deepEqual(status.impact, { manager: true, dependencies: false, api: true, web: false, cms: false, deployment: false });
  assert.equal(fixture.git(fixture.checkout, "rev-parse", "HEAD"), before);
  assert.match(fs.readFileSync(path.join(fixture.checkout, "logs/git.out.log"), "utf8"), /\$ git fetch/);
});

test("fetch explains an unwritable object directory and succeeds once access is restored", {
  skip: process.platform === "win32" || process.geteuid?.() === 0
}, async t => {
  const fixture = sandbox(t);
  const commit = fixture.publish({ "README.md": "Incoming change\n" });
  // Fetch unpacks this commit into its two-character directory even when objects/ itself is writable.
  const bucket = path.join(fixture.checkout, ".git", "objects", commit.slice(0, 2));
  fs.mkdirSync(bucket, { recursive: true });
  const mode = fs.statSync(bucket).mode & 0o777;
  const repo = fixture.updater();
  fs.chmodSync(bucket, 0o555);
  try {
    await assert.rejects(repo.fetch(), /Git cannot write incoming objects[\s\S]*insufficient permission for adding an object/);
    assert.match(fs.readFileSync(path.join(fixture.checkout, "logs/git.err.log"), "utf8"), /Grant the account that runs Manager write access/);
  } finally {
    fs.chmodSync(bucket, mode);
  }
  assert.equal((await repo.fetch()).behind, 1);
});

test("pull preflight reports an existing index lock and leaves it in place", async t => {
  const fixture = sandbox(t);
  const commit = fixture.publish({ "README.md": "Incoming change\n" });
  const lock = path.join(fixture.checkout, ".git", "index.lock");
  fs.writeFileSync(lock, "in use");
  await assert.rejects(fixture.updater().prepare(commit), /existing Git lock[\s\S]*index\.lock': File exists/i);
  assert.equal(fs.readFileSync(lock, "utf8"), "in use");
});

test("pull preflight reports index lock permission denial and can retry after the directory is writable", {
  skip: process.platform === "win32" || process.geteuid?.() === 0
}, async t => {
  const fixture = sandbox(t);
  const commit = fixture.publish({ "README.md": "Incoming change\n" });
  const repo = fixture.updater();
  await repo.fetch();
  const gitDir = path.join(fixture.checkout, ".git");
  const mode = fs.statSync(gitDir).mode & 0o777;
  fs.chmodSync(gitDir, 0o555);
  try {
    await assert.rejects(repo.prepare(commit), error => {
      assert.match(error.message, /write access to the directory[\s\S]*index\.lock': Permission denied/i);
      assert.doesNotMatch(error.message, /another Git process|delete the .lock/i);
      return true;
    });
  } finally {
    fs.chmodSync(gitDir, mode);
  }
  await repo.fastForward(await repo.prepare(commit));
  assert.equal(fixture.git(fixture.checkout, "rev-parse", "HEAD"), commit);
});

test("pull handles stale file metadata while preserving staged and unstaged local edits", async t => {
  const fixture = sandbox(t);
  const repo = fixture.updater();
  const target = fixture.publish({ "README.md": "New upstream documentation\n" });
  const customized = "deployment/docker/compose.yaml";
  fixture.write(fixture.checkout, customized, "staged configuration\n");
  fixture.git(fixture.checkout, "add", "--", customized);
  fixture.write(fixture.checkout, customized, "working configuration\n");
  // A permissions change or touch can invalidate cached stat data without changing the blob.
  const earlier = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(path.join(fixture.checkout, "README.md"), earlier, earlier);

  await repo.fastForward(await repo.prepare(target));
  assert.equal(fixture.git(fixture.checkout, "rev-parse", "HEAD"), target);
  assert.equal(fixture.git(fixture.checkout, "show", ":" + customized), "staged configuration");
  assert.equal(fs.readFileSync(path.join(fixture.checkout, customized), "utf8"), "working configuration\n");
});

test("checkout impact includes the services consuming storage config and the shared lockfile", async t => {
  const fixture = sandbox(t);
  const repo = fixture.updater();
  const storage = await repo.prepare(fixture.publish({ "config/storage.cjs": "module.exports = {};\n" }, "Update storage"));
  assert.equal(storage.impact.cms, true);
  assert.equal(storage.impact.api, true);
  assert.equal(storage.impact.web, false);
  await repo.fastForward(storage);
  const lock = await repo.prepare(fixture.publish({ "package-lock.json": "{}\n" }, "Update shared dependencies"));
  assert.equal(lock.rootDependencies, true);
  assert.deepEqual(lock.impact, { manager:false, dependencies:true, api:true, web:true, cms:true, deployment:false });
});

test("fast-forwards to the exact reviewed commit, even when upstream has moved on", async t => {
  const fixture = sandbox(t);
  const reviewed = fixture.publish({ "apps/web/src/page.tsx": "web v2\n" }, "Reviewed");
  const repo = fixture.updater();
  await repo.fetch();
  const later = fixture.publish({ "apps/web/src/page.tsx": "web v3\n" }, "Not reviewed yet");
  const plan = await repo.prepare(reviewed);
  assert.equal(plan.upToDate, false);
  assert.equal(plan.count, 1);
  assert.equal(plan.impact.web, true);
  const result = await repo.fastForward(plan);
  assert.equal(fixture.git(fixture.checkout, "rev-parse", "HEAD"), reviewed);
  assert.notEqual(reviewed, later);
  assert.match(result.message, /Fast-forwarded main from \w{7} to \w{7} \(1 commit\)/);
  assert.equal(fs.readFileSync(path.join(fixture.checkout, "apps/web/src/page.tsx"), "utf8"), "web v2\n");
  const again = await repo.prepare(reviewed);
  assert.equal(again.upToDate, true);
});

test("keeps unrelated local edits and refuses edits the update would overwrite", async t => {
  const fixture = sandbox(t);
  // Servers customize tracked deployment files; an unrelated update keeps them.
  fixture.write(fixture.checkout, "deployment/docker/compose.yaml", "server customization\n");
  const first = fixture.publish({ "apps/web/src/page.tsx": "web v2\n" });
  const repo = fixture.updater();
  await repo.fastForward(await repo.prepare(first));
  assert.equal(fixture.git(fixture.checkout, "rev-parse", "HEAD"), first);
  assert.equal(fs.readFileSync(path.join(fixture.checkout, "deployment/docker/compose.yaml"), "utf8"), "server customization\n");

  const second = fixture.publish({ "deployment/docker/compose.yaml": "upstream compose\n" });
  await repo.fetch();
  const status = await repo.status();
  assert.deepEqual(status.conflicts, ["deployment/docker/compose.yaml"]);
  await assert.rejects(repo.prepare(second), error => error.statusCode === 409 && /deployment\/docker\/compose\.yaml would be overwritten.*never discards/.test(error.message));
  assert.equal(fixture.git(fixture.checkout, "rev-parse", "HEAD"), first);
  assert.equal(fs.readFileSync(path.join(fixture.checkout, "deployment/docker/compose.yaml"), "utf8"), "server customization\n");
});

test("an untracked file in the way fails verification before anything changes", async t => {
  const fixture = sandbox(t);
  const target = fixture.publish({ "apps/api/src/new-module.cjs": "upstream\n" });
  fixture.write(fixture.checkout, "apps/api/src/new-module.cjs", "local draft\n");
  const repo = fixture.updater();
  await assert.rejects(repo.prepare(target), /untracked working tree files would be overwritten|would be overwritten/);
  assert.equal(fs.readFileSync(path.join(fixture.checkout, "apps/api/src/new-module.cjs"), "utf8"), "local draft\n");
  assert.equal(fixture.git(fixture.checkout, "status", "--porcelain", "--untracked-files=no"), "");
});

test("ignored local files block preflight and remain protected after preflight", async t => {
  const fixture = sandbox(t);
  const filename = "deployment/local-settings";
  fixture.write(fixture.checkout, ".git/info/exclude", filename + "\n");
  fixture.write(fixture.checkout, filename, "keep this local configuration");
  const target = fixture.publish({ [filename]: "upstream configuration" });
  const repo = fixture.updater();
  await assert.rejects(repo.prepare(target), { statusCode: 409 });
  fs.renameSync(path.join(fixture.checkout, filename), path.join(fixture.dir, "saved"));
  const plan = await repo.prepare(target);
  fs.renameSync(path.join(fixture.dir, "saved"), path.join(fixture.checkout, filename));
  await assert.rejects(repo.fastForward(plan), /overwritten/);
  assert.equal(fs.readFileSync(path.join(fixture.checkout, filename), "utf8"), "keep this local configuration");
  assert.equal(fixture.git(fixture.checkout, "rev-parse", "HEAD"), plan.from);
});

test("rejects a deleted upstream even when its tracking ref still exists", async t => {
  const f = sandbox(t);
  const target = f.publish({ "README.md": "reviewed" });
  f.git(f.author, "push", "origin", "HEAD:release");
  f.git(f.checkout, "fetch"); f.git(f.checkout, "branch", "--set-upstream-to=origin/release");
  f.git(f.author, "push", "origin", "--delete", "release");
  assert.equal(f.git(f.checkout, "rev-parse", "origin/release"), target);
  await assert.rejects(f.updater().prepare(target), /remote ref.*release/);
});

test("preflight protects ignored files on either side of a file/directory replacement", async t => {
  for (const [incoming, local] of [["runtime", "runtime/settings.env"], ["runtime/settings.env", "runtime"]]) {
    const f = sandbox(t), repo = f.updater();
    f.write(f.checkout, ".git/info/exclude", "runtime\n");
    f.write(f.checkout, local, "private configuration");
    const target = f.publish({ [incoming]: "upstream version" });
    await assert.rejects(repo.prepare(target), { statusCode: 409 });
    assert.equal(fs.readFileSync(path.join(f.checkout, local), "utf8"), "private configuration");
  }
});

test("a different branch at the verified commit must not be updated", async t => {
  const f = sandbox(t);
  const target = f.publish({ "README.md": "update" });
  const repo = f.updater(), plan = await repo.prepare(target);
  f.git(f.checkout, "switch", "-c", "other");
  await assert.rejects(repo.fastForward(plan), { statusCode: 409 });
  assert.equal(f.git(f.checkout, "rev-parse", "other"), plan.from);
  assert.equal(f.git(f.checkout, "rev-parse", "main"), plan.from);
});

test("refuses diverged branches, rewritten history, detached HEAD and malformed targets", async t => {
  const fixture = sandbox(t);
  const repo = fixture.updater();
  await assert.rejects(repo.prepare("--upload-pack=touch /tmp/x"), error => error.statusCode === 400);

  const remoteOnly = fixture.publish({ "README.md": "remote\n" });
  fixture.write(fixture.checkout, "README.md", "local commit\n");
  fixture.git(fixture.checkout, "commit", "--quiet", "-am", "Local only");
  await assert.rejects(repo.prepare(remoteOnly), /local commits that are not on origin\/main.*only fast-forwards/);
  fixture.git(fixture.checkout, "reset", "--quiet", "--hard", "origin/main~1");

  // The reviewed commit disappears from upstream after a force push.
  fixture.git(fixture.author, "reset", "--quiet", "--hard", "HEAD~1");
  const replacement = fixture.publish({ "README.md": "rewritten\n" }, "Rewritten", "--force");
  await assert.rejects(repo.prepare(remoteOnly), /no longer on origin\/main/);
  assert.equal((await repo.prepare(replacement)).upToDate, false);

  fixture.git(fixture.checkout, "checkout", "--quiet", "--detach");
  await assert.rejects(repo.prepare(replacement), /HEAD is detached/);
});

test("never waits for prompts, keeps polling lock-free and redacts remote credentials", async t => {
  const fixture = sandbox(t);
  fixture.git(fixture.checkout, "remote", "set-url", "origin", "https://user:secret-token@example.invalid/repo.git");
  const calls = [];
  const spy = (file, args, options, callback) => { calls.push({ args, env: options.env }); return execFile(file, args, options, callback); };
  const repo = fixture.updater({ execFile: spy, fetchTimeoutMs: 20000 });
  const status = await repo.status();
  assert.equal(status.remote, "https://example.invalid/repo.git");
  assert.doesNotMatch(JSON.stringify(status), /secret-token/);
  assert.ok(calls.every(call => call.env.GIT_TERMINAL_PROMPT === "0" && call.env.GCM_INTERACTIVE === "never" && call.env.GIT_OPTIONAL_LOCKS === "0"));
  await assert.rejects(repo.fetch());
  const fetchCall = calls.find(call => call.args[0] === "fetch");
  assert.equal(fetchCall.env.GIT_SSH_COMMAND, "ssh -o BatchMode=yes");
  assert.equal(fetchCall.env.GIT_OPTIONAL_LOCKS, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(fixture.checkout, "logs/git.out.log"), "utf8"), /secret-token/);

  // An administrator's own SSH client choice is respected.
  fixture.git(fixture.checkout, "config", "core.sshCommand", "ssh -i /keys/deploy");
  calls.length = 0;
  await assert.rejects(repo.fetch());
  assert.equal(calls.find(call => call.args[0] === "fetch").env.GIT_SSH_COMMAND, undefined);
});

test("explains missing Git, timeouts and untrusted ownership", async t => {
  const fixture = sandbox(t);
  const fail = error => (file, args, options, callback) => callback(Object.assign(new Error("fixture"), error), "", error.stderr || "");
  let repo = fixture.updater({ execFile: fail({ code: "ENOENT" }) });
  assert.match((await repo.status()).error, /Git was not found.*MANAGER_GIT_PATH/);
  repo = fixture.updater({ execFile: fail({ code: 128, stderr: "fatal: detected dubious ownership in repository at '/srv/repo'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /srv/repo" }) });
  assert.match((await repo.status()).error, /another account owns it[\s\S]*safe\.directory \/srv\/repo/);
  let call = 0;
  const slowFetch = (file, args, options, callback) => args[0] === "fetch"
    ? callback(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), "", "")
    : (call++, execFile(file, args, options, callback));
  repo = fixture.updater({ execFile: slowFetch, fetchTimeoutMs: 1000 });
  await assert.rejects(repo.fetch(), /git fetch did not finish within 1 s/);
  assert.ok(call > 0);
  assert.match(fs.readFileSync(path.join(fixture.checkout, "logs/git.err.log"), "utf8"), /did not finish/);
});
