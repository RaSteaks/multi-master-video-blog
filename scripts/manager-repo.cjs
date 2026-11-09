const fsp = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

// Updates the checkout Manager runs from by fast-forward only. It never merges,
// rebases, stashes, resets, cleans or edits Git configuration: local commits and
// local edits to incoming files stop the update instead of being replaced.
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const COMMIT_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%cI";
const LISTED = 20;
const LOCK_WRITE_DENIED = /\.lock': Permission denied/i;
// These inputs define the automatic, non-destructive CMS upgrade contract.
const SCHEMA_FILES = ["scripts/setup-directus-schema.cjs", "scripts/directus-db-utils.cjs",
  "scripts/directus-asset-presets.cjs", "config/directus-asset-presets.json", "shared/project-layouts.cjs"];

function dependencyGraph(packages, workspace) {
  const graph = new Map();
  const visit = directory => {
    if (graph.has(directory)) return;
    const entry = packages[directory];
    if (!entry || typeof entry !== "object") throw new Error("Incomplete lockfile");
    if (entry.link) {
      graph.set(directory, entry);
      visit(entry.resolved);
      return;
    }
    // npm's dev/optional flags describe placement across the whole installation,
    // not a change to the package consumed by this particular service.
    const { dev, optional, devOptional, peer, ...identity } = entry;
    const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
    graph.set(directory, directory === workspace
      ? Object.fromEntries(fields.map(field => [field, entry[field]])) : identity);
    for (const field of fields) {
      for (const name of Object.keys(entry[field] || {})) {
        let parent = directory;
        let resolved;
        while (true) {
          const candidate = (parent ? parent + "/" : "") + "node_modules/" + name;
          if (packages[candidate]) { resolved = candidate; break; }
          if (!parent) break;
          parent = path.posix.dirname(parent);
          if (parent === ".") parent = "";
        }
        if (resolved) visit(resolved);
        else if (!["optionalDependencies", "peerDependencies"].includes(field) && !entry.optionalDependencies?.[name]) {
          throw new Error("Incomplete dependency graph");
        }
      }
    }
  };
  visit(workspace);
  return graph;
}

function createRepoUpdater({ root, execFile, gitPath = "git", env = {}, platform, loadedFiles = () => [], fetchTimeoutMs = 120000 }) {
  const outLog = path.join(root, "logs", "git.out.log");
  const errLog = path.join(root, "logs", "git.err.log");
  // Manager runs hidden on Windows and under systemd on Linux. Nothing can answer
  // a credential, host-key or retry prompt, so Git must fail instead of waiting.
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C", LANGUAGE: "C" };

  function run(args, { timeout = 15000, write = false, extraEnv } = {}) {
    return new Promise(resolve => {
      execFile(gitPath, args, {
        cwd: root, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
        // Status polling must not take index.lock from an administrator's own Git command.
        env: { ...gitEnv, ...(write ? {} : { GIT_OPTIONAL_LOCKS: "0" }), ...extraEnv }
      }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") }));
    });
  }

  async function git(args, options = {}) {
    const { error, stdout, stderr } = await run(args, options);
    if (options.log) {
      await fsp.appendFile(outLog, "$ git " + args.join(" ") + "\n" + stdout + stderr
        + (error ? "(exit " + (error.code ?? error.signal) + ")\n" : "")).catch(() => {});
    }
    if (error) throw gitError(args, error, stderr, options.timeout || 15000);
    return stdout;
  }

  async function logged(title, reset, task) {
    await fsp.mkdir(path.dirname(outLog), { recursive: true });
    const header = "== " + new Date().toISOString() + " " + title + "\n";
    if (reset) await Promise.all([fsp.writeFile(outLog, header), fsp.writeFile(errLog, "")]);
    else await fsp.appendFile(outLog, header);
    try {
      return await task();
    } catch (error) {
      await fsp.appendFile(errLog, new Date().toISOString() + " " + title + "\n" + error.message + "\n").catch(() => {});
      throw error;
    }
  }

  async function sshEnv() {
    // BatchMode makes OpenSSH fail on a passphrase or unknown host key instead of
    // waiting. An explicitly configured SSH client (PuTTY, a key path) is kept.
    if (env.GIT_SSH_COMMAND || env.GIT_SSH) return {};
    const configured = await git(["config", "--get", "core.sshCommand"]).then(trim, () => "");
    return configured ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  }

  async function fetchUpstream(branch) {
    const [remote, ref] = await Promise.all(["remote", "merge"].map(field =>
      git(["config", "--get", `branch.${branch}.${field}`]).then(trim)));
    // Request the actual remote ref: a wildcard fetch can succeed after it was deleted.
    await git(["fetch", "--no-recurse-submodules", "--", remote, ref], { write: true, log: true, timeout: fetchTimeoutMs, extraEnv: await sshEnv() });
  }

  async function isAncestor(ancestor, descendant) {
    try {
      await git(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (error.exitCode === 1) return false;
      throw error;
    }
  }

  function changedFiles(from, to) {
    // --no-renames lists both sides of a rename; either can collide with local edits.
    const range = to ? [from, to] : [from];
    return git(["diff", "--name-only", "--no-renames", "-z", ...range]).then(splitZ);
  }

  function localChanges(options) {
    return git(["status", "--porcelain=v1", "-z", "--untracked-files=no"], options).then(parsePorcelain);
  }

  async function protectUntrackedFiles(from, to) {
    const added = splitZ(await git(["diff", "--name-only", "--no-renames", "--diff-filter=AT", "-z", from, to]));
    for (const name of added) {
      // A file can obstruct a new directory, or an incoming file can replace a
      // directory of local files. Ask the index only for paths present on disk.
      const parts = name.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const relative = parts.slice(0, i).join("/");
        const stat = await fsp.lstat(path.join(root, relative)).catch(error => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (!stat) break;
        if (i < parts.length && stat.isDirectory()) continue;
        // No exclusion rules here: ignored runtime/configuration files also count.
        const others = await git(["--literal-pathspecs", "ls-files", "--others", "--directory", "--no-empty-directory", "-z", "--", relative]);
        if (others) throw conflict("Local untracked files would be overwritten by the update: " + splitZ(others)[0]);
        break;
      }
    }
  }

  async function classify(files, from, to) {
    const loaded = new Set(loadedFiles());
    const any = test => files.some(test);
    const dependencies = await dependencyImpact(files, from, to);
    const all = dependencies.root || any(file => ["scripts/run-service.cjs", "config/resource-profile.cjs"].includes(file));
    const shared = file => file.startsWith("shared/") || file === "config/directus-asset-presets.json";
    return {
      manager: any(file => loaded.has(file)),
      dependencies: Object.values(dependencies).some(Boolean),
      schema: any(file => SCHEMA_FILES.includes(file)),
      api: all || dependencies.api || any(file => file.startsWith("apps/api/") || shared(file) || file === "config/storage.cjs"),
      web: all || dependencies.web || any(file => file.startsWith("apps/web/") || shared(file)),
      cms: all || dependencies.cms || any(file => file.startsWith("apps/cms/") || ["config/storage.cjs", "config/directus-runtime.json", "config/private-cms-collections.json",
        "scripts/directus-db-utils.cjs", "scripts/directus-public-access.cjs"].includes(file)),
      deployment: any(file => file.startsWith("deployment/"))
    };
  }

  async function dependencyImpact(files, from, to) {
    const workspaces = { root: "", cms: "apps/cms/directus", api: "apps/api", web: "apps/web" };
    const manifests = Object.values(workspaces).map(dir => dir ? dir + "/package.json" : "package.json");
    if (!files.some(file => file === "package-lock.json" || manifests.includes(file))) {
      return { root: false, cms: false, api: false, web: false };
    }
    // Read both committed dependency graphs: a Web-only lockfile update must not
    // restart CMS/API, but changed shared transitive packages affect every consumer.
    try {
      const revisions = await Promise.all([from, to].map(async revision => {
        const [lock, manifest] = await Promise.all(["package-lock.json", "package.json"].map(async file =>
          JSON.parse(await git(["show", revision + ":" + file]))));
        if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) throw new Error("Unsupported lockfile");
        const changedManifests = await Promise.all(Object.entries(workspaces).filter(([, dir]) =>
          dir && files.includes(dir + "/package.json")).map(async ([id, dir]) =>
          [id, JSON.parse(await git(["show", revision + ":" + dir + "/package.json"]))]));
        return { lock, manifest, manifests: { root: manifest, ...Object.fromEntries(changedManifests) } };
      }));
      return Object.fromEntries(Object.entries(workspaces).map(([id, dir]) => {
        const snapshots = revisions.map(({ lock, manifest, manifests }) => {
          const graph = dependencyGraph(lock.packages, dir);
          const declared = Object.fromEntries(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].map(field =>
            [field, manifests[id]?.[field]]));
          // Root scripts and overrides can change service launch/install behavior;
          // descriptive metadata and engine declarations do not reload a service.
          return id === "root" ? { graph, declared, scripts: manifest.scripts, overrides: manifest.overrides, workspaces: manifest.workspaces } : { graph, declared };
        });
        return [id, !isDeepStrictEqual(...snapshots)];
      }));
    } catch {
      // Old, missing or incomplete lockfiles cannot prove which services are safe.
      return { root: true, cms: true, api: true, web: true };
    }
  }

  async function readStatus() {
    if (trim(await git(["rev-parse", "--is-inside-work-tree"])) !== "true") {
      throw new Error("Manager is not running inside a Git working tree.");
    }
    const markers = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "FETCH_HEAD"];
    const [branch, head, upstream, local, paths] = await Promise.all([
      git(["symbolic-ref", "--quiet", "--short", "HEAD"]).then(trim, () => null),
      git(["log", "-1", "--format=" + COMMIT_FORMAT, "HEAD"]).then(text => parseCommits(text)[0]),
      git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).then(trim, () => null),
      localChanges(),
      git(["rev-parse", ...markers.flatMap(name => ["--git-path", name])]).then(lines)
    ]);
    const fetchHead = path.resolve(root, paths.pop());
    const [inProgress, lastFetchedAt] = await Promise.all([
      Promise.all(paths.map(item => exists(path.resolve(root, item)))).then(found => found.some(Boolean)),
      fsp.stat(fetchHead).then(stat => stat.mtime.toISOString(), () => null)
    ]);
    const state = {
      available: true, root, branch, head, upstream, upstreamHead: null, remote: null,
      ahead: 0, behind: 0, incoming: [], changedFiles: 0, impact: await classify([]), conflicts: [],
      localChanges: local.length, localFiles: local.slice(0, LISTED), inProgress, lastFetchedAt
    };
    if (!upstream) return state;
    const [counts, upstreamHead, remote, incoming, files] = await Promise.all([
      git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
      git(["log", "-1", "--format=" + COMMIT_FORMAT, "@{upstream}"]).then(text => parseCommits(text)[0]),
      remoteUrl(branch),
      git(["log", "--max-count=" + LISTED, "--format=" + COMMIT_FORMAT, "HEAD..@{upstream}"]).then(parseCommits),
      changedFiles("HEAD...@{upstream}")
    ]);
    const [ahead, behind] = trim(counts).split(/\s+/).map(Number);
    return {
      ...state, upstreamHead, remote, ahead, behind, incoming,
      changedFiles: files.length, impact: await classify(files, await git(["merge-base", "HEAD", "@{upstream}"]).then(trim), upstreamHead.hash), conflicts: overlap(local, files)
    };
  }

  async function remoteUrl(branch) {
    if (!branch) return null;
    try {
      const name = trim(await git(["config", "--get", "branch." + branch + ".remote"]));
      return redactUrl(trim(await git(["remote", "get-url", name])));
    } catch {
      return null;
    }
  }

  function requireTracking(state) {
    if (!state.available) throw Object.assign(new Error(state.error), { statusCode: 409 });
    if (!state.branch) throw conflict("HEAD is detached. Check out the deployment branch in a terminal first.");
    if (!state.upstream) {
      throw conflict(state.branch + " has no upstream branch. Run git branch --set-upstream-to=origin/" + state.branch + " once in a terminal.");
    }
  }

  // Network-free and read-only; safe for periodic polling.
  async function status() {
    try {
      return await readStatus();
    } catch (error) {
      return { available: false, root, error: error.message };
    }
  }

  function fetchUpdates() {
    return logged("fetch", true, async () => {
      const before = await status();
      requireTracking(before);
      await fetchUpstream(before.branch);
      const after = await status();
      requireTracking(after);
      return {
        message: after.behind
          ? after.upstream + " has " + commits(after.behind) + " that " + after.branch + " does not."
          : after.branch + " is up to date with " + after.upstream + ".",
        behind: after.behind
      };
    });
  }

  // Fetches, then proves the update is a clean fast-forward to the reviewed
  // commit before any caller stops a service.
  function prepare(target) {
    return logged("verify " + (target || "@{upstream}"), true, async () => {
      if (target != null && !COMMIT_ID.test(String(target))) throw badRequest("The pull target must be a full commit ID.");
      const before = await status();
      requireTracking(before);
      if (before.inProgress) throw conflict("A merge, rebase, cherry-pick or revert is in progress. Finish or abort it in a terminal first.");
      await fetchUpstream(before.branch);
      const [upstreamId, from] = await Promise.all([
        // Validate against the branch just advertised, independent of refspec caching.
        git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).then(trim),
        git(["rev-parse", "--verify", "HEAD^{commit}"]).then(trim)
      ]);
      const to = target || upstreamId;
      if (target) {
        await git(["cat-file", "-e", to + "^{commit}"]).catch(() => {
          throw conflict("Commit " + short(to) + " is not available locally. Check for updates and review again.");
        });
        if (!await isAncestor(to, upstreamId)) {
          throw conflict("Commit " + short(to) + " is no longer on " + before.upstream + "; the remote history changed. Check for updates and review again.");
        }
      }
      const base = { branch: before.branch, upstream: before.upstream, from, to };
      if (from === to || await isAncestor(to, from)) {
        return { ...base, upToDate: true, count: 0, changedFiles: 0, impact: await classify([]), message: before.branch + " already contains " + short(to) + "." };
      }
      if (!await isAncestor(from, to)) {
        throw conflict(before.branch + " has local commits that are not on " + before.upstream + ". Manager only fast-forwards; reconcile the branch in a terminal.");
      }
      const [count, files, local] = await Promise.all([
        git(["rev-list", "--count", from + ".." + to]).then(text => Number(trim(text))),
        changedFiles(from, to),
        // Unlike polling, Pull must let status refresh the index's stat cache before read-tree.
        // Otherwise an ACL or timestamp change alone can make a clean file look out of date.
        localChanges({ write: true })
      ]);
      const conflicts = overlap(local, files);
      if (conflicts.length) {
        throw conflict("Local changes to " + conflicts.join(", ") + " would be overwritten by the update. Commit, stash or discard them in a terminal; Manager never discards local work.");
      }
      // Git's own checkout checks (untracked files in the way, index state),
      // without touching the index or working tree.
      await protectUntrackedFiles(from, to);
      await git(["read-tree", "--dry-run", "-m", "-u", from, to], { write: true, log: true });
      return {
        ...base, upToDate: false, count, changedFiles: files.length, impact: await classify(files, from, to),
        rootDependencies: files.includes("package.json") || files.includes("package-lock.json"),
        message: "Verified a fast-forward of " + before.branch + " from " + short(from) + " to " + short(to) + " (" + commits(count) + ")."
      };
    });
  }

  function fastForward(plan) {
    return logged("fast-forward " + short(plan.to), false, async () => {
      const branch = trim(await git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""));
      if (branch !== plan.branch) throw conflict("The checked-out branch changed after verification. Check for updates and review again.");
      const head = trim(await git(["rev-parse", "--verify", "HEAD^{commit}"]));
      if (head !== plan.from) throw conflict("HEAD moved after the update was verified. Check for updates and review again.");
      try {
        await git(["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", plan.to], { write: true, log: true, timeout: 120000 });
      } catch (error) {
        if (platform === "win32" && !LOCK_WRITE_DENIED.test(error.message)
          && /unable to unlink|permission denied|invalid argument|resource busy|unable to create file/i.test(error.message)) {
          error.message += "\nA running process may hold a file in this checkout open. Pull + Update API + Web stops API and Web before updating.";
        }
        error.message += "\nRun git status in a terminal before retrying; an interrupted update can leave files changed.";
        throw error;
      }
      const after = trim(await git(["rev-parse", "--verify", "HEAD^{commit}"]));
      if (after !== plan.to) throw new Error("Git finished but HEAD is " + short(after) + ", not " + short(plan.to) + ". Inspect the checkout in a terminal.");
      return {
        from: plan.from, to: plan.to,
        message: "Fast-forwarded " + plan.branch + " from " + short(plan.from) + " to " + short(plan.to) + " (" + commits(plan.count) + ")."
      };
    });
  }

  return { status, fetch: fetchUpdates, prepare, fastForward };
}

function gitError(args, error, stderr, timeout) {
  const detail = stderr.trim().split(/\r?\n/).slice(-8).join("\n") || error.message;
  let hint = "";
  if (error.code === "ENOENT") {
    hint = "Git was not found. Install Git (Git for Windows on Windows) for the account that runs Manager, or set MANAGER_GIT_PATH, then restart Manager.";
  } else if (error.killed) {
    hint = "git " + args[0] + " did not finish within " + Math.round(timeout / 1000) + " s and was stopped. Check network access to the remote.";
  } else if (/dubious ownership/i.test(detail)) {
    hint = "Git does not trust this checkout because another account owns it. Run the safe.directory command below as the account that runs Manager.";
  } else if (/insufficient permission for adding an object to repository database/i.test(detail)) {
    hint = "Git cannot write incoming objects to this checkout. Grant the account that runs Manager write access to the object directories named below, then retry Check for updates.";
  } else if (/terminal prompts disabled|could not read (?:username|password)|authentication failed|permission denied \(publickey|host key verification failed/i.test(detail)) {
    hint = "The remote needs credentials that Manager cannot type. Configure a credential helper, token or SSH key that works without a prompt for the account that runs Manager.";
  } else if (LOCK_WRITE_DENIED.test(detail)) {
    hint = "Git could not create the lock file. Grant the account that runs Manager write access to the directory containing the lock path below, then retry.";
  } else if (/\.lock': File exists/i.test(detail)) {
    hint = "An existing Git lock blocks this operation. Wait for any Git process using the checkout to finish before retrying.";
  } else if (/not a git repository/i.test(detail)) {
    hint = "Manager is not running from a Git checkout, so it cannot update it.";
  }
  return Object.assign(new Error(hint ? hint + "\n" + detail : detail), {
    exitCode: typeof error.code === "number" ? error.code : null
  });
}

function parseCommits(text) {
  return lines(text).map(line => {
    const [hash, shortHash, subject, author, date] = line.split("\x1f");
    return { hash, short: shortHash, subject, author, date };
  });
}

function parsePorcelain(text) {
  const entries = text.split("\0");
  const files = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // Renames and copies name their original path in the following entry.
    if (/^[RC]/.test(entry) && entries[index + 1]) files.push(entries[++index]);
  }
  return files;
}

function overlap(local, incoming) {
  const changed = new Set(incoming);
  return [...new Set(local.filter(file => changed.has(file)))].slice(0, LISTED);
}

function redactUrl(url) {
  // Tokens embedded in HTTPS remotes must never reach the page or logs.
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

function exists(file) {
  return fsp.access(file).then(() => true, () => false);
}

const trim = text => String(text).trim();
const lines = text => String(text).split(/\r?\n/).filter(Boolean);
const splitZ = text => String(text).split("\0").filter(Boolean);
const short = id => String(id).slice(0, 7);
const commits = count => count + " commit" + (count === 1 ? "" : "s");
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const badRequest = message => Object.assign(new Error(message), { statusCode: 400 });

module.exports = { createRepoUpdater, COMMIT_ID, SCHEMA_FILES };
