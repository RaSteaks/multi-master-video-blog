const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createOssObjects } = require("./object-storage.cjs");

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};

async function fileSha256(filename) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

/** Video processing stays on disk; only verified, registered publications may be evicted. */
function createVideoStorage({ mediaRoot, journalRoot, env = {}, objectStore }) {
  const driver = env.VIDEO_STORAGE || "local";
  if (!["local", "oss"].includes(driver)) throw new Error("VIDEO_STORAGE must be local or oss.");
  if (driver === "local") return {
    enabled: false, init: async () => {}, close: async () => {},
    publish: async () => null, complete: async () => false
  };

  const config = videoOssConfig(env);
  const objects = objectStore || createOssObjects(config);
  const root = path.resolve(mediaRoot);
  const journal = path.resolve(journalRoot);
  if (journal === root || inside(root, journal) || inside(journal, root)) {
    throw new Error("Video OSS cleanup journals must be separate from MEDIA_ROOT.");
  }
  let timer, cleaning;
  const unqueued = new Map();
  const key = relative => `${config.prefix}/${relative}`;

  async function publish({ sourcePath, playlistPath, archiveDir }) {
    const realRoot = await fsp.realpath(root);
    const files = new Map();
    async function collect(filename) {
      const stat = await fsp.lstat(filename);
      if (stat.isSymbolicLink()) throw new Error("Video publications cannot contain symbolic links.");
      const real = await fsp.realpath(filename);
      if (!inside(realRoot, real)) throw new Error("Video publication must stay inside MEDIA_ROOT.");
      if (stat.isDirectory()) {
        for (const entry of await fsp.readdir(real)) await collect(path.join(real, entry));
      } else if (stat.isFile()) {
        const relative = path.relative(realRoot, real).split(path.sep).join("/");
        files.set(relative, { relative, size: stat.size, filename: real });
      } else throw new Error("Video publications must contain regular files.");
    }
    await collect(archiveDir || sourcePath);
    await collect(path.dirname(playlistPath));
    // Keep every playlist behind its segments, including nested HLS packages.
    const entries = [...files.values()].sort((a, b) =>
      Number(a.relative.endsWith(".m3u8")) - Number(b.relative.endsWith(".m3u8")) || a.relative.localeCompare(b.relative));
    const receipt = [];
    for (const entry of entries) {
      const sha256 = await fileSha256(entry.filename);
      const stored = await objects.stat(key(entry.relative));
      if (stored && (stored.size !== entry.size || stored.sha256 !== sha256)) {
        throw fail(409, "An OSS video object already exists with different contents. Local files were retained.");
      }
      if (!stored) await objects.upload({ key: key(entry.relative), filename: entry.filename,
        size: entry.size, sha256, contentType: videoContentType(entry.relative) });
      const confirmed = await objects.stat(key(entry.relative));
      if (!confirmed || confirmed.size !== entry.size || confirmed.sha256 !== sha256) {
        throw fail(502, "OSS video verification failed. Local files were retained.");
      }
      receipt.push({ relative: entry.relative, size: entry.size, sha256 });
    }
    return receipt;
  }

  async function writeReceipt(id, receipt) {
    const temporary = path.join(journal, `${crypto.randomUUID()}.tmp`);
    await fsp.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600, flag: "wx", flush: true });
    await fsp.rename(temporary, path.join(journal, `${id}.json`));
    if (process.platform !== "win32") {
      const directory = await fsp.open(journal, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }

  async function retryCleanup() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      const realRoot = await fsp.realpath(root);
      let pending = false;
      // Legacy multipart requests have no session journal to retry a failed receipt write.
      for (const [id, receipt] of unqueued) {
        try { await writeReceipt(id, receipt); unqueued.delete(id); }
        catch (error) { pending = true; console.error(`[video-oss] Receipt write deferred: ${error.message}`); }
      }
      for (const name of await fsp.readdir(journal)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          // Journals survive a crash between CMS publication and local deletion.
          const receipt = JSON.parse(await fsp.readFile(path.join(journal, name), "utf8"));
          if (!Array.isArray(receipt) || !receipt.length || receipt.some(entry =>
            typeof entry.relative !== "string" || entry.relative.includes("\\") ||
            entry.relative.split("/").some(part => !part || part === "." || part === "..") ||
            !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))) {
            throw new Error("Invalid video OSS cleanup journal.");
          }
          // Recheck the entire receipt before deleting even one local file.
          for (const entry of receipt) {
            const stored = await objects.stat(key(entry.relative));
            if (!stored || stored.size !== entry.size || stored.sha256 !== entry.sha256) {
              throw new Error("OSS copy is unavailable or changed; retaining local video files.");
            }
          }
          const directories = new Set();
          for (const entry of receipt) {
            const filename = path.resolve(realRoot, entry.relative);
            if (!inside(realRoot, filename)) throw new Error("Invalid video cleanup path.");
            const real = await fsp.realpath(filename).catch(error => {
              if (error.code !== "ENOENT") throw error;
              return null;
            });
            if (real) {
              if (real !== filename) throw new Error("Refusing to clean a linked video path.");
              // A restore or repair can replace the local file while this receipt is pending.
              const stat = await fsp.stat(filename);
              if (!stat.isFile() || stat.size !== entry.size || await fileSha256(filename) !== entry.sha256) {
                throw new Error(`Local file differs from its published copy; retaining ${entry.relative}.`);
              }
              // Hashing a large master can take seconds; reject a replacement or edit during that read.
              const current = await fsp.lstat(filename);
              if (current.dev !== stat.dev || current.ino !== stat.ino || current.ctimeMs !== stat.ctimeMs) {
                throw new Error(`Local file changed during verification; retaining ${entry.relative}.`);
              }
              await fsp.unlink(filename);
            }
            for (let directory = path.dirname(filename); inside(realRoot, directory); directory = path.dirname(directory)) {
              directories.add(directory);
            }
          }
          // Source directories can be shared by other masters; remove empty directories only.
          for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
            await fsp.rmdir(directory).catch(error => {
              if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
            });
          }
          await fsp.unlink(path.join(journal, name));
        } catch (error) {
          pending = true;
          console.error(`[video-oss] Local cleanup deferred: ${error.message}`);
        }
      }
      return pending;
    })();
    try { return await cleaning; } finally { cleaning = null; }
  }

  return {
    enabled: true,
    async init() {
      await fsp.mkdir(journal, { recursive: true, mode: 0o700 });
      const [realRoot, realJournal] = await Promise.all([fsp.realpath(root), fsp.realpath(journal)]);
      if (realRoot === realJournal || inside(realRoot, realJournal) || inside(realJournal, realRoot)) {
        throw new Error("Video OSS cleanup journals must not resolve into MEDIA_ROOT.");
      }
      const retry = () => void retryCleanup().catch(error => console.error(`[video-oss] Cleanup retry failed: ${error.message}`));
      timer = setInterval(retry, 60_000);
      timer.unref();
      retry();
    },
    publish,
    async complete(publications, sessionId) {
      const receipt = [...new Map(publications.flat().map(entry => [entry.relative, entry])).values()];
      if (!receipt.length) return false;
      const id = sessionId || crypto.randomUUID();
      try { await writeReceipt(id, receipt); }
      catch (error) {
        if (!sessionId) unqueued.set(id, receipt);
        throw error;
      }
      await cleaning;
      return retryCleanup();
    },
    async stat(relative, signal) {
      const object = await objects.stat(key(relative), signal);
      if (!object) throw fail(404, "Media file not found.");
      return object;
    },
    read: (relative, range, signal) => objects.read(key(relative), range, signal),
    async close() {
      clearInterval(timer);
      await cleaning;
      objects.close?.();
    }
  };
}

function videoOssConfig(env) {
  for (const name of ["BUCKET", "REGION", "ENDPOINT", "KEY", "SECRET"]) {
    if (!env[`VIDEO_OSS_${name}`]?.trim()) throw new Error(`VIDEO_OSS_${name} is required when VIDEO_STORAGE=oss.`);
  }
  const endpoint = new URL(env.VIDEO_OSS_ENDPOINT);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("VIDEO_OSS_ENDPOINT must be an HTTP(S) service origin.");
  const prefix = (env.VIDEO_OSS_ROOT || "blog_all/videos").replace(/^\/+|\/+$/g, "");
  if (prefix.includes("\\") || prefix.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("VIDEO_OSS_ROOT must be an object prefix without traversal.");
  }
  return { bucket: env.VIDEO_OSS_BUCKET, region: env.VIDEO_OSS_REGION,
    endpoint: endpoint.origin, prefix, key: env.VIDEO_OSS_KEY, secret: env.VIDEO_OSS_SECRET };
}

function videoContentType(filename) {
  return ({ ".m3u8": "application/vnd.apple.mpegurl", ".m4s": "video/iso.segment",
    ".mp4": "video/mp4", ".ts": "video/mp2t", ".aac": "audio/aac", ".vtt": "text/vtt",
    ".json": "application/json", ".xml": "application/xml", ".mov": "video/quicktime" })[path.extname(filename).toLowerCase()]
    || "application/octet-stream";
}

module.exports = { createVideoStorage };
