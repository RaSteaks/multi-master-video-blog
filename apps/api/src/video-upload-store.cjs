const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const lockfile = require("proper-lockfile");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = new Set(["projectId", "sourceKind", "dolbyXmlClipName", "title", "slug",
  "description", "tags", "masterType", "label", "mode", "notes", "published", "isDefault", "overwrite"]);
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** One API process owns this durable spool. Confirmed offsets only advance after fsync. */
function createVideoUploadStore({ root, mediaRoot, maxFileBytes, maxCoverBytes,
  maxTotalBytes = 8 * 1024 ** 3, quotaBytes = 20 * 1024 ** 3, maxSessions = 32,
  chunkBytes = 1024 ** 2, ttlMs = 7 * 24 * 3600_000, processUpload,
  canProcess = () => true, now = Date.now }) {
  const sessions = new Map();
  const legacyReservations = new Map();
  const busy = new Set();
  let draining = false, closed = false, timer, unlock;
  const folder = id => path.join(root, id);
  const dataPath = (id, index) => path.join(folder(id), `${index}.bin`);

  async function save(session) {
    // Replace the journal atomically; a failed write never advances the in-memory offset.
    const temporary = path.join(folder(session.id), "session.next");
    const handle = await fsp.open(temporary, "w", 0o600);
    try { await handle.writeFile(JSON.stringify(session)); await handle.sync(); }
    finally { await handle.close(); }
    await fsp.rename(temporary, path.join(folder(session.id), "session.json"));
    // Persist the directory entry too on POSIX; Windows does not support opening directories.
    if (process.platform !== "win32") {
      const directory = await fsp.open(folder(session.id), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    sessions.set(session.id, session);
  }

  function get(id) {
    if (!UUID.test(id)) throw fail(404, "Upload session not found.");
    const session = sessions.get(id);
    if (!session) throw fail(404, "Upload session not found or expired.");
    if (session.expiresAt <= now() && !["queued", "processing"].includes(session.state)) {
      throw fail(410, "Upload session expired. Start a new upload.");
    }
    return session;
  }

  function view(session) {
    return { id: session.id, state: session.state, phase: session.phase,
      expiresAt: session.expiresAt, chunkBytes, fields: session.fields,
      files: session.files.map(({ chunks, ...file }) => file),
      result: session.result || null, error: session.error || null };
  }

  async function exclusive(id, operation) {
    if (busy.has(id)) throw fail(409, "This upload is being updated. Refresh its offset and retry.");
    busy.add(id);
    try { return await operation(); } finally { busy.delete(id); }
  }

  function manifest(input) {
    if (!input || !input.fields || typeof input.fields !== "object" || Array.isArray(input.fields) ||
        !Array.isArray(input.files) || !input.files.length || input.files.length > 500) {
      throw fail(400, "A video upload requires metadata and 1–500 files.");
    }
    const fields = {};
    for (const key of Object.keys(input.fields).sort()) {
      if (!FIELDS.has(key) || typeof input.fields[key] !== "string" || input.fields[key].length > 65536) {
        throw fail(400, "Invalid upload metadata.");
      }
      fields[key] = input.fields[key];
    }
    const counts = {};
    const files = input.files.map(file => {
      if (!file || !["video", "sdrVideo", "cover", "masterPackage"].includes(file.field) ||
          typeof file.name !== "string" || !file.name || file.name.length > 1024 ||
          /[\\:\0]/.test(file.name) || file.name.split("/").some(part => !part || part === "." || part === "..") ||
          (file.field !== "masterPackage" && file.name.includes("/")) ||
          !Number.isSafeInteger(file.size) || file.size < 1 ||
          file.size > (file.field === "cover" ? maxCoverBytes : maxFileBytes) ||
          typeof file.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(file.fingerprint)) {
        throw fail(400, "Invalid upload file, path, fingerprint or size.");
      }
      counts[file.field] = (counts[file.field] || 0) + 1;
      return { field: file.field, name: file.name, size: file.size,
        type: String(file.type || "").slice(0, 200), fingerprint: file.fingerprint };
    });
    if ((counts.video || 0) > 2 || (counts.sdrVideo || 0) > 1 || (counts.cover || 0) > 1 ||
        (counts.video && counts.masterPackage) || (counts.video === 2 && counts.sdrVideo) ||
        (fields.sourceKind === "embedded" ? !counts.video : !counts.masterPackage)) {
      throw fail(400, "Invalid video/package file combination.");
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(total) || total > maxTotalBytes) throw fail(413, "Upload exceeds the session size limit.");
    return { fields, files, total };
  }

  async function cleanup() {
    for (const session of sessions.values()) {
      // Never expire queued or running jobs. Failed/interrupted sources retain the same TTL.
      if (session.expiresAt > now() || ["queued", "processing"].includes(session.state) || busy.has(session.id)) continue;
      await exclusive(session.id, async () => {
        await fsp.rm(folder(session.id), { recursive: true, force: true });
        sessions.delete(session.id);
      });
    }
  }

  async function create(id, input) {
    if (!UUID.test(id)) throw fail(400, "Upload ID must be a UUID v4.");
    const validated = manifest(input);
    const signature = crypto.createHash("sha256").update(JSON.stringify(validated)).digest("hex");
    // Serialize reservations too: concurrent creators cannot overbook the disk quota.
    return exclusive("create", async () => {
      await cleanup();
      if (sessions.has(id)) {
        const existing = get(id);
        if (existing.signature !== signature) throw fail(409, "Upload ID already belongs to different files or metadata.");
        return view(existing);
      }
      const reserved = [...sessions.values()].reduce((sum, item) => sum + item.total, 0)
        + [...legacyReservations.values()].reduce((sum, bytes) => sum + bytes, 0);
      if (sessions.size + legacyReservations.size >= maxSessions || reserved + validated.total > quotaBytes) {
        throw fail(503, "Upload storage is full. Retry after existing sessions expire.");
      }
      const disk = await fsp.statfs(root);
      // Processing can need a second source copy on filesystems without hard links.
      if (disk.bavail * disk.bsize < (reserved + validated.total) * 2 + 64 * 1024 ** 2) {
        throw fail(507, "Insufficient free disk space for this upload.");
      }
      await fsp.mkdir(folder(id), { mode: 0o700 });
      const session = { id, signature, ...validated, state: "receiving", phase: "uploading",
        expiresAt: now() + ttlMs, files: validated.files.map(file => ({ ...file, offset: 0, chunks: [] })) };
      try { await save(session); }
      catch (error) { await fsp.rm(folder(id), { recursive: true, force: true }); throw error; }
      return view(session);
    });
  }

  // Legacy multipart uses the same quota and reservation lock as resumable sessions.
  // Reserve before reading a body; keep ownership until its temporary files are gone.
  async function reserveLegacy(bytes, storagePath = root) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxTotalBytes) throw fail(413, "Upload exceeds the session size limit.");
    return exclusive("create", async () => {
      await cleanup();
      const reserved = [...sessions.values()].reduce((sum, item) => sum + item.total, 0)
        + [...legacyReservations.values()].reduce((sum, value) => sum + value, 0);
      if (sessions.size + legacyReservations.size >= maxSessions || reserved + bytes > quotaBytes) throw fail(503, "Upload storage is full.");
      const disk = await fsp.statfs(root);
      if (disk.bavail * disk.bsize < (reserved + bytes) * 2 + 64 * 1024 ** 2) throw fail(507, "Insufficient free disk space.");
      // Native/Docker installs can put the legacy spool on another filesystem.
      await fsp.mkdir(storagePath, { recursive: true });
      const spool = await fsp.statfs(storagePath);
      const legacyBytes = [...legacyReservations.values()].reduce((sum, value) => sum + value, 0) + bytes;
      if (spool.bavail * spool.bsize < legacyBytes + 64 * 1024 ** 2) throw fail(507, "Insufficient free upload-spool space.");
      const id = crypto.randomUUID(); legacyReservations.set(id, bytes);
      return () => legacyReservations.delete(id);
    });
  }

  async function append(id, index, req) {
    return exclusive(id, async () => {
      const session = get(id), file = session.files[index];
      if (session.state !== "receiving" || !file) throw fail(409, "This file is not accepting chunks.");
      const offset = Number(req.headers["upload-offset"]);
      const checksum = String(req.headers["upload-checksum"] || "");
      const length = Math.min(chunkBytes, file.size - file.offset);
      if (!/^\d+$/.test(String(req.headers["upload-offset"] || "")) || offset !== file.offset) {
        throw fail(409, "Upload offset changed. Query the session before retrying.");
      }
      if (!length || !/^[a-f0-9]{64}$/.test(checksum) || req.headers["content-type"] !== "application/octet-stream") {
        throw fail(400, "A binary chunk with its SHA-256 checksum is required.");
      }
      if (req.headers["content-length"] && Number(req.headers["content-length"]) !== length) {
        throw fail(400, "Chunk length does not match the next file range.");
      }
      const temporary = path.join(folder(id), "chunk.part");
      let size = 0;
      const hash = crypto.createHash("sha256");
      const meter = new Transform({ transform(chunk, encoding, done) {
        size += chunk.length;
        if (size > length) return done(fail(413, "Chunk exceeds the allowed size."));
        hash.update(chunk); done(null, chunk);
      } });
      try {
        // Incoming data is bounded by one disk-backed chunk, including aborted requests.
        await pipeline(req, meter, fs.createWriteStream(temporary, { mode: 0o600 }));
        if (size !== length || hash.digest("hex") !== checksum) throw fail(422, "Chunk checksum or length mismatch.");
        const destination = dataPath(id, index);
        const handle = await fsp.open(destination, file.offset ? "r+" : "w", 0o600);
        try {
          // A crash between data fsync and journal rename leaves an unconfirmed tail.
          await handle.truncate(file.offset);
          let position = file.offset;
          for await (const chunk of fs.createReadStream(temporary)) {
            let written = 0;
            while (written < chunk.length) {
              const result = await handle.write(chunk, written, chunk.length - written, position);
              written += result.bytesWritten; position += result.bytesWritten;
            }
          }
          await handle.sync();
        } finally { await handle.close(); }
        const next = structuredClone(session);
        next.files[index].offset += length;
        next.files[index].chunks.push(checksum);
        next.expiresAt = now() + ttlMs;
        await save(next);
        return { offset: next.files[index].offset };
      } finally { await fsp.rm(temporary, { force: true }); }
    });
  }

  async function complete(id) {
    // A repeated completion must return the existing job even while its worker owns the lock.
    const existing = get(id);
    if (existing.state !== "receiving") return view(existing);
    return exclusive(id, async () => {
      const session = get(id);
      if (session.state !== "receiving") return view(session);
      if (session.files.some(file => file.offset !== file.size)) throw fail(409, "Upload is incomplete.");
      const next = { ...session, state: "queued", phase: "queued", expiresAt: now() + ttlMs };
      await save(next);
      setImmediate(() => void drain());
      return view(next);
    });
  }

  async function parsedInput(session) {
    const work = path.join(folder(session.id), "work");
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work);
    const files = {};
    for (const [index, file] of session.files.entries()) {
      const tempPath = path.join(work, String(index));
      try { await fsp.link(dataPath(session.id, index), tempPath); }
      catch (error) {
        if (!["EXDEV", "EPERM", "EOPNOTSUPP", "ENOTSUP"].includes(error.code)) throw error;
        await fsp.copyFile(dataPath(session.id, index), tempPath, fs.constants.COPYFILE_FICLONE);
      }
      const item = { field: file.field, filename: file.name, originalName: file.name,
        size: file.size, mimeType: file.type, tempPath, tempDir: work };
      if (file.field === "video") {
        (files.videos ||= []).push(item); files.video ||= item;
      } else if (file.field === "masterPackage") (files.masterPackage ||= []).push(item);
      else files[file.field] = item;
    }
    return { fields: session.fields, files, file: files.video || null, tempDir: work };
  }

  async function drain() {
    if (draining || closed || !canProcess()) return;
    draining = true;
    try {
      for (const queued of sessions.values()) {
        if (closed || !canProcess()) break;
        if (queued.state !== "queued" || busy.has(queued.id)) continue;
        await exclusive(queued.id, async () => {
          try {
            const parsed = await parsedInput(queued);
            const checkpoint = async (phase, result) => {
              await save({ ...get(queued.id), state: "processing", phase,
                ...(result ? { result } : {}) });
            };
            const result = await processUpload(parsed, checkpoint);
            await save({ ...get(queued.id), state: "completed", phase: "completed", result, expiresAt: now() + ttlMs });
          } catch (error) {
            const current = get(queued.id);
            // Admission failure is recoverable and retains the completed upload.
            if (current.state === "queued" && error.statusCode === 503) return;
            await save({ ...current, state: current.phase === "publishing" ? "interrupted" : "failed",
              error: String(error.message).slice(0, 2000),
              result: current.result || error.uploadResult, expiresAt: now() + ttlMs });
          } finally {
            await fsp.rm(path.join(folder(queued.id), "work"), { recursive: true, force: true });
          }
        });
      }
    } catch (error) {
      console.error("[video-upload] Worker paused:", error.message);
    } finally { draining = false; }
  }

  async function init() {
    if (inside(mediaRoot, root) || inside(root, mediaRoot)) throw new Error("VIDEO_UPLOAD_ROOT must be separate from MEDIA_ROOT.");
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.mkdir(mediaRoot, { recursive: true });
    const [realRoot, realMedia] = await Promise.all([fsp.realpath(root), fsp.realpath(mediaRoot)]);
    if (inside(realMedia, realRoot) || inside(realRoot, realMedia)) throw new Error("Video upload storage must not resolve into public media.");
    // Windows Stop-Process cannot run exit cleanup. Allow its abandoned lock to
    // age past the 30s lease (plus timestamp precision), without stealing a live
    // worker's heartbeat. Other storage errors still fail immediately.
    for (let attempt = 0; ; attempt++) {
      try {
        unlock = await lockfile.lock(root, { realpath: true, stale: 30000, update: 10000 });
        break;
      } catch (error) {
        if (error.code !== "ELOCKED") throw error;
        if (attempt >= 35) {
          error.message = `Video upload storage is still locked after waiting 35 seconds: ${root}. Stop the other API process using this VIDEO_UPLOAD_ROOT before retrying; do not delete an active lock.`;
          throw error;
        }
        if (attempt === 0) console.warn("[video-upload] Waiting up to 35 seconds for the previous API storage lock to expire.");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    try {
      for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
        if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const filename = path.join(root, entry.name, "session.json");
        let session;
        try { session = JSON.parse(await fsp.readFile(filename, "utf8")); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (session.id !== entry.name) throw new Error("Invalid video upload journal.");
        if (session.state === "processing") {
          // Before publication replay is safe; after publication use the saved primary result.
          if (session.phase === "processing") session = { ...session, state: "queued", phase: "queued" };
          else if (session.phase === "derivatives" && session.result) {
            session = { ...session, state: "completed", phase: "completed",
              result: { ...session.result, processingInterrupted: true } };
          } else session = { ...session, state: "interrupted",
            error: "Publication was interrupted. Check the project's saved masters before starting another upload." };
          await save(session);
        } else sessions.set(session.id, session);
      }
      await cleanup();
      timer = setInterval(() => { void cleanup().catch(console.error); void drain(); }, 5000);
      timer.unref();
    } catch (error) { await unlock(); throw error; }
  }

  return { init, create, append, complete, drain, reserveLegacy,
    status: id => view(get(id)),
    receipts(id, index) {
      const file = get(id).files[index];
      if (!file) throw fail(404, "Upload file not found.");
      return { offset: file.offset, chunks: file.chunks, chunkBytes };
    },
    async cancel(id) {
      if (!["receiving", "queued"].includes(get(id).state)) throw fail(409, "This upload can no longer be canceled.");
      return exclusive(id, async () => {
        const current = get(id);
        if (!["receiving", "queued"].includes(current.state)) throw fail(409, "Processing has already started.");
        // Cancel preserves bytes until expiry so a second tab cannot race deletion with a read.
        const next = { ...current, state: "canceled", phase: "canceled" };
        await save(next); return view(next);
      });
    },
    snapshot: () => ({ sessions: sessions.size, active: draining,
      queued: [...sessions.values()].filter(s => s.state === "queued").length }),
    taskSummaries: () => [...sessions.values()].filter(session => session.expiresAt > now()
      || ["queued", "processing"].includes(session.state)).reverse().map(session => ({
      id: `video:${session.id}`, kind: "video", label: session.fields.title || "视频上传",
      state: session.state,
      // Encoder phases have no measured percentage; never turn upload completion
      // into a fabricated encoding percentage.
      progress: session.state === "receiving" ? Math.round(session.files.reduce((sum, file) => sum + file.offset, 0) / session.total * 100)
        : session.state === "completed" ? 100 : null,
    })),
    async close() {
      closed = true; clearInterval(timer);
      while (draining) await new Promise(resolve => setTimeout(resolve, 20));
      await unlock?.();
    }
  };
}

module.exports = { createVideoUploadStore };
