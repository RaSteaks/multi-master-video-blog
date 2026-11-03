const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createOssObjects } = require("./object-storage.cjs");

const owners = { posts: "article", albums: "album", video_projects: "videos" };
const parents = { album_photos: { field: "album_id", kind: "album" }, video_masters: { field: "project_id", kind: "videos" },
  album_photo_renditions: { field: "photo_id", kind: "album", through: true } };
const collections = { article: "posts", album: "albums", videos: "video_projects" };
const idOf = value => value && typeof value === "object" ? value.id : value;
// Accept root-relative site asset URLs in Markdown/HTML, including shared video covers.
const assetReference = /(?:^|[\s(<"'])\/(?:(?:api|media)\/)?assets\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?=$|[\s)\]<>"'?#/.])/gi;

/** Durable, coalesced snapshots supplement the CMS database without replacing its editor/query model. */
function createContentArchive({ config, journalRoot, request, objectStore }) {
  if (!config) return { enabled: false, before: async () => null, after: async () => {},
    init: async () => {}, flush: async () => false, close: async () => {},
    status: async () => ({ enabled: false, pending: 0 }) };
  const objects = objectStore || createOssObjects(config);
  const journal = path.resolve(journalRoot);
  const prefix = config.root ? `${config.root}/` : "";
  const unwritten = new Map();
  let timer, scheduled, draining, dirty = false, closed = false;

  async function enqueue(kind, id, slug) {
    if (!["string", "number"].includes(typeof id)) throw new Error("Invalid content archive owner.");
    id = String(id);
    if (!collections[kind] || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid content archive owner.");
    const job = { kind, id, ...(slug ? { slug } : {}), generation: crypto.randomUUID() };
    const temporary = path.join(journal, `${job.generation}.tmp`);
    const name = `${kind}-${id}.json`;
    try {
      await fs.writeFile(temporary, JSON.stringify(job), { flag: "wx", mode: 0o600, flush: true });
      await fs.rename(temporary, path.join(journal, name));
    } catch (error) {
      // The CMS has committed. Retry when the disk recovers; startup also scans saved records.
      unwritten.set(name, job);
      throw error;
    }
    dirty = true;
    // A batch can create many photo rows; coalesce them into one album snapshot.
    clearTimeout(scheduled);
    scheduled = setTimeout(() => void flush().catch(error => console.error(`[content-archive] ${error.message}`)), 500);
    scheduled.unref();
  }

  async function ownerOf(parent, row) {
    const id = idOf(row[parent.field]);
    if (!parent.through) return { kind: parent.kind, id };
    const photo = (await request(`/items/album_photos/${id}?fields=album_id`)).data;
    return { kind: parent.kind, id: idOf(photo.album_id) };
  }

  async function before({ pathname, method }) {
    const match = pathname.split("?", 1)[0].match(/^\/items\/(posts|albums|video_projects|album_photos|video_masters|album_photo_renditions)(?:\/([^/]+))?$/);
    if (!match) return null;
    const mutation = { collection: match[1], id: match[2], method };
    // Capture a child's owner while it still exists, including rollback deletions.
    const parent = parents[mutation.collection];
    if (parent && method === "DELETE" && mutation.id) {
      const row = (await request(`/items/${mutation.collection}/${mutation.id}?fields=${parent.field}`)).data;
      mutation.owner = await ownerOf(parent, row);
    } else if (mutation.collection === "video_projects" && method === "DELETE" && mutation.id) {
      // A video tombstone belongs beside its previous slug-based latest.json.
      mutation.slug = (await readOwner("videos", mutation.id, "slug"))?.slug;
    }
    return mutation;
  }

  async function after(mutation, data) {
    if (mutation.owner) return enqueue(mutation.owner.kind, mutation.owner.id);
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    if (!rows.length && mutation.id) rows.push({ id: mutation.id });
    const direct = owners[mutation.collection];
    if (direct) {
      for (const row of rows) await enqueue(direct, idOf(row), direct === "videos" ? row.slug || mutation.slug : undefined);
      return;
    }
    const parent = parents[mutation.collection];
    for (const row of rows) {
      const saved = row[parent.field] ? row : (await request(`/items/${mutation.collection}/${idOf(row)}?fields=${parent.field}`)).data;
      const owner = await ownerOf(parent, saved);
      await enqueue(owner.kind, owner.id);
    }
  }

  async function allRows(collection, query = {}) {
    const rows = [];
    const params = new URLSearchParams({ fields: "*", sort: "id", limit: "100", ...query });
    for (let offset = 0; ; offset += 100) {
      params.set("offset", String(offset));
      const page = (await request(`/items/${collection}?${params}`)).data;
      rows.push(...page);
      if (page.length < 100) return rows;
    }
  }

  async function readOwner(kind, id, fields) {
    // Directus readOne uses 403 for absent IDs too. A successful collection
    // lookup distinguishes absence from an HTTP permission or service error.
    const ownerQuery = new URLSearchParams({ fields, "filter[id][_eq]": id, limit: "1" });
    const [record] = (await request(`/items/${collections[kind]}?${ownerQuery}`)).data;
    return record;
  }

  async function snapshot(job) {
    const record = await readOwner(job.kind, job.id, "*");
    if (!record) return { format: "video-blog-content-v1", kind: job.kind, id: job.id, deleted: true };
    const result = { format: "video-blog-content-v1", kind: job.kind, id: job.id, record };
    if (job.kind === "album") result.photos = await allRows("album_photos", { fields: "*,renditions.*", "filter[album_id][_eq]": job.id });
    if (job.kind === "videos") result.masters = await allRows("video_masters", { "filter[project_id][_eq]": job.id });
    const fileIds = new Set([record.cover_image, record.backgroundimage].map(idOf).filter(Boolean));
    for (const match of String(record.content || "").matchAll(assetReference)) fileIds.add(match[1].toLowerCase());
    for (const photo of result.photos || []) {
      for (const file of [photo.sdr_image, photo.hdr_image, ...(photo.renditions || []).map(rendition => rendition.file)]) {
        if (idOf(file)) fileIds.add(idOf(file));
      }
    }
    result.files = [];
    for (const id of [...fileIds].map(String).sort()) {
      const query = new URLSearchParams({ fields: "id,storage,filename_disk,filename_download,type,filesize,width,height,title,description",
        "filter[id][_eq]": id, limit: "1" });
      const [file] = (await request(`/files?${query}`)).data;
      if (file) {
        const location = { oss_article: `${prefix}article/assets`, oss_album: `${prefix}album/assets`,
          oss_video: `${prefix}videos/assets`, oss: config.root }[file.storage];
        result.files.push({ ...file, object_key: location != null && file.filename_disk
          ? [location, file.filename_disk].filter(Boolean).join("/") : null });
      } else {
        result.files.push({ id, missing: true });
      }
    }
    return result;
  }

  async function writeVerified(key, bytes, contentType, mutable = false) {
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const stored = await objects.stat(key);
    if (stored?.size === bytes.length && stored.sha256 === sha256) return;
    if (stored && !mutable) throw new Error("An immutable content archive object has conflicting contents.");
    await objects.write({ key, bytes, sha256, contentType });
    const confirmed = await objects.stat(key);
    if (!confirmed || confirmed.size !== bytes.length || confirmed.sha256 !== sha256) throw new Error("Content archive verification failed.");
  }

  async function flush() {
    dirty = true;
    if (draining) return draining;
    draining = (async () => {
      let pending = false;
      for (const [name, { kind, id, slug }] of [...unwritten]) {
        // A failure during this retry puts the owner back, even if a newer edit arrived.
        unwritten.delete(name);
        try { await enqueue(kind, id, slug); }
        catch (error) {
          pending = true;
          console.error(`[content-archive] Outbox still unavailable: ${error.message}`);
        }
      }
      while (dirty && !closed) {
        dirty = false;
        const names = new Set((await fs.readdir(journal)).map(name => name.replace(/\.working\.json$/, ".json")));
        for (const name of names) {
          if (!/^(article|album|videos)-[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
          try {
            // Claim before reading. Concurrent edits replace only the pending name.
            // A failed/crashed claim is retried, or superseded by a newer job for the same owner.
            const claimed = path.join(journal, name.replace(/\.json$/, ".working.json"));
            await fs.rename(path.join(journal, name), claimed).catch(error => {
              if (error.code !== "ENOENT") throw error;
            });
            const job = JSON.parse(await fs.readFile(claimed, "utf8"));
            if (!collections[job.kind] || !/^[a-zA-Z0-9_-]{1,128}$/.test(job.id) ||
                !/^[a-f0-9-]{36}$/.test(job.generation)) throw new Error("Invalid content archive journal.");
            const content = await snapshot(job);
            const bytes = Buffer.from(JSON.stringify(content, null, 2));
            const revision = crypto.createHash("sha256").update(bytes).digest("hex");
            const base = job.kind === "videos"
              ? `${prefix}videos/${encodeURIComponent(content.record?.slug || job.slug || job.id)}/metadata`
              : `${prefix}${job.kind}/${job.id}`;
            const metadataKey = `${base}/${revision}/metadata.json`;
            const contentKey = job.kind === "article" && !content.deleted ? `${base}/${revision}/content.md` : null;
            if (contentKey) await writeVerified(contentKey, Buffer.from(content.record.content || ""), "text/markdown; charset=utf-8");
            await writeVerified(metadataKey, bytes, "application/json");
            await writeVerified(`${base}/latest.json`, Buffer.from(JSON.stringify({ format: "video-blog-content-v1",
              kind: job.kind, id: job.id, revision, metadataKey, contentKey })), "application/json", true);
            await fs.unlink(claimed);
          } catch (error) {
            pending = true;
            console.error(`[content-archive] Snapshot deferred (${name}): ${error.message}`);
          }
        }
      }
      return pending;
    })();
    try { return await draining; } finally { draining = null; }
  }

  return {
    enabled: true, before, after, flush,
    async status() {
      const names = await fs.readdir(journal);
      const owners = new Set([...unwritten.keys(), ...names.filter(name => name.endsWith(".json")).map(name => name.replace(/\.working\.json$/, ".json"))]);
      return { enabled: true, active: Boolean(draining), pending: owners.size };
    },
    async init() {
      await fs.mkdir(journal, { recursive: true, mode: 0o700 });
      // Reject a read-only outbox before the API can accept content mutations.
      const probe = path.join(journal, `${crypto.randomUUID()}.tmp`);
      await fs.writeFile(probe, "", { flag: "wx", mode: 0o600 });
      await fs.unlink(probe);
      timer = setInterval(() => void flush().catch(error => console.error(`[content-archive] ${error.message}`)), 60_000);
      timer.unref();
      // Back up existing text/metadata too, and heal a missed enqueue after a prior crash.
      for (const [kind, collection] of Object.entries(collections)) {
        for (const row of await allRows(collection, { fields: "id" })) await enqueue(kind, row.id);
      }
    },
    async close() {
      closed = true; clearTimeout(scheduled); clearInterval(timer);
      await draining;
      objects.close?.();
    }
  };
}

module.exports = { createContentArchive };
