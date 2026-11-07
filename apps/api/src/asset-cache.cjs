const { createHash } = require("node:crypto");
const { requestIsFresh } = require("./http-utils.cjs");

const FILE_FIELDS = "modified_on,uploaded_on,filename_disk,storage,type,filesize,focal_point_x,focal_point_y";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

/** Byte cache only: callers must authorize every request before consulting it. */
function createAssetCache({ request, fetchAsset, presets, maxBytes = 16 * 1024 ** 2,
  maxEntryBytes = 2 * 1024 ** 2, maxEntries = 256, maxPending = 4, ttlMs = 300_000, now = Date.now }) {
  const entries = new Map(), pending = new Map(), metadataReads = new Map();
  let bytes = 0;

  function remove(key) {
    const entry = entries.get(key);
    if (entry) bytes -= entry.body.length;
    entries.delete(key);
  }

  function lookup(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) { remove(key); return null; }
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  async function version(fileId, token) {
    // Share concurrent metadata reads, but never retain a file version across requests.
    // This also detects replacements/deletions performed directly in the CMS.
    if (!metadataReads.has(fileId)) {
      const work = request(`/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}`, token)
        .finally(() => metadataReads.delete(fileId));
      metadataReads.set(fileId, work);
    }
    let file;
    try { file = (await metadataReads.get(fileId)).data; }
    catch (error) {
      // Older/narrow service roles may read assets without these metadata fields.
      // Preserve their uncached transport; outages/deletions still fail closed.
      if ((error.directusHttpStatus || error.statusCode) === 403) return null;
      throw error;
    }
    if (!file || !Object.hasOwn(file, "modified_on") || !(file.modified_on || file.uploaded_on)
      || typeof file.filename_disk !== "string" || typeof file.storage !== "string"
      || !IMAGE_TYPES.has(file.type)) return null;
    return { hash: createHash("sha256").update(JSON.stringify(FILE_FIELDS.split(",").map(field => file[field] ?? null))).digest("hex"), type: file.type };
  }

  function cachedResponse(entry, method, status) {
    // Share the immutable buffer instead of Response(Buffer) copying it per slow reader.
    const body = method === "HEAD" ? null : new ReadableStream({ start(controller) {
      controller.enqueue(entry.body);
      controller.close();
    } });
    return { response: new Response(body, { headers: entry.headers }), cacheStatus: status };
  }

  async function get({ fileId, preset, token, headers = {}, method = "GET", signal, privateRequest = false, onWait = () => {} }) {
    const upstream = async (validators = headers) => fetchAsset(fileId, preset, token, validators, method, signal);
    // Private previews and disabled caches retain the original streaming path.
    if (privateRequest || maxBytes <= 0 || !["GET", "HEAD"].includes(method)) {
      return { response: await upstream(), cacheStatus: "BYPASS" };
    }
    const revision = await version(fileId, token);
    signal?.throwIfAborted();
    if (!revision) return { response: await upstream(), cacheStatus: "BYPASS" };
    const definition = preset ? presets.find(item => item.key === preset) : null;
    const key = JSON.stringify([fileId, revision.hash, preset, definition]);
    // Directus validators have second precision. Include full file metadata and the
    // managed preset so rapid replacements/specification changes get a new validator.
    const etag = `W/"asset-${createHash("sha256").update(key).digest("hex")}"`;
    if (requestIsFresh(headers, etag, NaN)) {
      return { response: new Response(null, { status: 304, headers: {
        etag, "content-type": definition?.format ? `image/${definition.format}` : revision.type
      } }), cacheStatus: "REVALIDATED" };
    }
    const hit = lookup(key);
    if (hit) return cachedResponse(hit, method, "HIT");
    while (pending.has(key)) {
      // Waiting for another client's streaming fill must not occupy admission slots.
      onWait();
      const shared = await waitForFill(pending.get(key).promise, signal);
      if (shared) return cachedResponse(shared, method, "COALESCED");
    }
    // HEAD does not warm an empty cache. Bound both retained bytes and active captures.
    if (method === "HEAD" || pending.size >= maxPending) return { response: await upstream(), cacheStatus: "BYPASS" };
    const fill = Promise.withResolvers();
    pending.set(key, fill);
    let settled = false;
    const finish = entry => {
      if (settled) return;
      settled = true;
      if (pending.get(key) === fill) pending.delete(key);
      fill.resolve(entry);
    };
    let response;
    // Our metadata validator replaces upstream validators on cacheable responses.
    // A stale browser validator must not trigger a coarse upstream 304 on a miss.
    try { response = await upstream({}); }
    catch (error) { finish(null); throw error; }
    const length = response.headers.get("content-length");
    const limit = Math.min(maxEntryBytes, maxBytes);
    if (response.status !== 200 || !response.body || !IMAGE_TYPES.has(response.headers.get("content-type")?.split(";")[0])
      || (length !== null && Number(length) > limit)) {
      finish(null);
      return { response, cacheStatus: "BYPASS" };
    }
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("etag", etag);
    // Preset changes have no file modification date; ETag is the reliable validator.
    responseHeaders.delete("last-modified");
    const reader = response.body.getReader();
    let chunks = [], size = 0;
    // Capture while streaming: the first visitor never waits for the full download.
    // No tee()/clone(): a slow consumer must not create an unbounded second queue.
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            if (!settled && (length === null || size === Number(length))) {
              const entry = { body: Buffer.concat(chunks, size),
                headers: Object.fromEntries(["content-type", "etag"].flatMap(name => {
                  const value = responseHeaders.get(name);
                  return value ? [[name, value]] : [];
                })), expiresAt: now() + ttlMs };
              entry.headers["content-length"] = String(size);
              // Old revisions expire independently; LRU also bounds metadata for tiny images.
              while (entries.size && (bytes + size > maxBytes || entries.size >= maxEntries)) remove(entries.keys().next().value);
              remove(key);
              entries.set(key, entry);
              bytes += size;
              finish(entry);
            } else finish(null);
            chunks = [];
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!settled) {
            size += next.value.byteLength;
            if (size <= limit) chunks.push(Buffer.from(next.value));
            else { chunks = []; finish(null); }
          }
          controller.enqueue(next.value);
        } catch (error) {
          chunks = [];
          finish(null);
          controller.error(error);
        }
      },
      async cancel(reason) {
        chunks = [];
        finish(null);
        await reader.cancel(reason);
      }
    });
    return { response: new Response(body, { status: response.status, headers: responseHeaders }), cacheStatus: "MISS" };
  }

  return { get };
}

function waitForFill(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); });
  });
}

module.exports = { createAssetCache };
