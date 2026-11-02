const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const deriveKey = promisify(crypto.scrypt);
const format = "video-blog-config-v1";
const maxBytes = 1024 * 1024;
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

function createConfigTransfer(root, systemDir = process.platform === "linux" ? "/etc/video-blog" : null) {
  const targets = new Map();
  for (const dir of ["", "apps/web", "apps/api", "apps/cms/directus", "cms", "deployment/docker"]) {
    for (const suffix of ["", ".local", ".development", ".development.local", ".production", ".production.local", ".test", ".test.local"]) {
      const name = path.posix.join(dir, ".env" + suffix);
      targets.set(name, path.join(root, name));
    }
  }
  // Use stable logical paths across machines, including customized deployment profiles.
  for (const name of [
    "deployment/docker/runtime.env", "deployment/docker/.release.env",
    "deployment/docker/compose.yaml", "deployment/docker/compose.override.yaml",
    "deployment/docker/compose.admin-local.yaml", "deployment/docker/compose.low-2gb.yaml",
    "deployment/docker/compose.low-4gb.yaml", "deployment/docker/compose.https.yaml",
    "deployment/docker/compose.vulkan.yaml", "deployment/docker/nginx.conf", "deployment/docker/nginx.https.conf",
    "deployment/nginx/blog-routes.conf", "deployment/nginx/linux-nginx.example.conf", "deployment/nginx/windows-nginx.example.conf",
    "deployment/linux/profiles/postgresql-low-2gb.conf", "deployment/linux/profiles/postgresql-low-4gb.conf",
    "deployment/linux/systemd/video-blog-web.service", "deployment/linux/systemd/video-blog-api.service",
    "deployment/linux/systemd/video-blog-cms.service",
    "config/directus-asset-presets.json", "config/private-cms-collections.json"
  ]) targets.set(name, path.join(root, name));

  // Only direct *.env children of the dedicated configuration directory qualify.
  // Apply the same rule at import even when the destination file does not exist.
  function systemTarget(name) {
    return systemDir && /^systemd\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.env$/.test(name)
      ? path.join(systemDir, name.slice("systemd/".length)) : undefined;
  }
  const target = name => targets.get(name) || systemTarget(name);

  async function inspect(name) {
    const file = target(name);
    // Resolve only fixed deployment slots. Reject linked files and linked subdirectories.
    const base = await fs.realpath(name.startsWith("systemd/") ? systemDir : root);
    const parent = path.dirname(file);
    if (await fs.realpath(parent) !== path.resolve(base, path.relative(name.startsWith("systemd/") ? systemDir : root, parent))) throw invalid("Linked configuration directories are unsupported: " + name);
    const stat = await fs.lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (stat && (!stat.isFile() || stat.size > maxBytes)) throw invalid("Unsupported configuration file: " + name);
    return stat;
  }

  function password(value) {
    if (typeof value !== "string" || value.length < 12 || value.length > 256) throw invalid("Use a backup password of 12–256 characters.");
    return value;
  }
  async function exportConfig(passphrase, onInventory) {
    password(passphrase);
    const files = {};
    const names = [...targets.keys()];
    if (systemDir) {
      const entries = await fs.readdir(systemDir).catch(error => {
        if (error.code !== "ENOENT") throw error;
        return [];
      });
      names.push(...entries.map(entry => "systemd/" + entry).filter(systemTarget).sort());
    }
    for (const name of names) {
      const file = target(name);
      try {
        if (await inspect(name)) files[name] = (await fs.readFile(file)).toString("base64");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const plain = Buffer.from(JSON.stringify(files));
    if (!Object.keys(files).length || plain.length > maxBytes) throw invalid("Configuration is empty or exceeds the backup size limit.");
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", await deriveKey(passphrase, salt, 32), iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    onInventory?.(Object.keys(files));
    return { format, data: Buffer.concat([salt, iv, cipher.getAuthTag(), data]).toString("base64") };
  }

  async function importConfig(passphrase, archive) {
    password(passphrase);
    if (archive?.format !== format || typeof archive.data !== "string" || archive.data.length > 2 * maxBytes) throw invalid("Unsupported configuration backup.");
    const bytes = Buffer.from(archive.data, "base64");
    let files;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", await deriveKey(passphrase, bytes.subarray(0, 16), 32), bytes.subarray(16, 28));
      decipher.setAuthTag(bytes.subarray(28, 44));
      files = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(44)), decipher.final()]));
    } catch { throw invalid("Incorrect backup password or damaged backup."); }
    if (!files || typeof files !== "object" || Array.isArray(files) || !Object.keys(files).length) throw invalid("Empty configuration backup.");
    const staged = [], applied = [];
    try {
      for (const [name, value] of Object.entries(files)) {
        if (!target(name) || typeof value !== "string") throw invalid("Backup contains unsupported configuration.");
        const stat = await inspect(name);
        const file = target(name);
        const content = Buffer.from(value, "base64");
        if (content.toString("base64") !== value) throw invalid("Invalid file encoding.");
        const temp = file + "." + crypto.randomUUID();
        const original = stat ? await fs.readFile(file) : null;
        staged.push({ file, temp, original, stat });
        await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
        if (stat && process.platform !== "win32") {
          await fs.chown(temp, stat.uid, stat.gid);
          await fs.chmod(temp, stat.mode & 0o777);
        }
      }
      // Validate and stage every destination before replacing any live file.
      for (const item of staged) {
        await fs.rename(item.temp, item.file);
        applied.push(item);
      }
    } catch (error) {
      for (const item of applied.reverse()) {
        if (item.original === null) await fs.unlink(item.file);
        else await fs.writeFile(item.file, item.original);
      }
      throw error;
    } finally {
      await Promise.all(staged.map(item => fs.rm(item.temp, { force: true })));
    }
    return Object.keys(files);
  }
  return { exportConfig, importConfig };
}
module.exports = { createConfigTransfer };
