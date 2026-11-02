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
  for (const dir of ["", "apps/web", "apps/api", "apps/cms/directus"]) {
    for (const suffix of ["", ".local", ".development", ".development.local", ".production", ".production.local", ".test", ".test.local"]) {
      const name = path.posix.join(dir, ".env" + suffix);
      targets.set(name, path.join(root, name));
    }
  }
  for (const name of ["deployment/docker/.env", "deployment/docker/runtime.env", "deployment/docker/.release.env",
    "config/directus-asset-presets.json", "config/private-cms-collections.json"]) targets.set(name, path.join(root, name));
  if (systemDir) for (const name of ["api.env", "cms.env", "web.env", "resources.env"]) targets.set("systemd/" + name, path.join(systemDir, name));

  async function inspect(name) {
    const file = targets.get(name);
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
  async function exportConfig(passphrase) {
    password(passphrase);
    const files = {};
    for (const [name, file] of targets) {
      try {
        if (await inspect(name)) files[name] = (await fs.readFile(file)).toString("base64");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const plain = Buffer.from(JSON.stringify(files));
    if (!Object.keys(files).length || plain.length > maxBytes) throw invalid("Configuration is empty or exceeds the backup size limit.");
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", await deriveKey(passphrase, salt, 32), iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
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
        if (!targets.has(name) || typeof value !== "string") throw invalid("Backup contains unsupported configuration.");
        const stat = await inspect(name);
        const file = targets.get(name);
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
