// CMS credentials authorize the service, not the anonymous caller. Check the owning
// content on every request, including conditional requests, so unpublishing revokes access.
async function canReadAsset(fileId, access, request, publicAssetIds = new Set(), hints = {}) {
  // Local About/branding content has no CMS owner; only explicit operator configuration
  // may declare those exceptional assets public (never a request header or query).
  if (publicAssetIds.has(fileId)) return true;
  const eq = value => ({ _eq: value });
  const publicOnly = privileged => privileged ? {} : { published: eq(true) };
  async function read(route) {
    try { return await request(route); }
    catch (error) {
      // A narrowly scoped service account may not read every content collection.
      // An inaccessible collection cannot grant access; genuine outages still fail closed.
      if ([403, 404].includes(error.directusHttpStatus || error.statusCode)) return { data: null };
      throw error;
    }
  }
  async function rows(collection, filter, fields = "id", limit = 1, offset = 0) {
    const params = new URLSearchParams({ filter: JSON.stringify(filter), fields,
      limit: String(limit), offset: String(offset), sort: "id" });
    const data = (await read(`/items/${collection}?${params}`)).data;
    return Array.isArray(data) ? data : [];
  }
  // Cache only the likely ownership route, never a positive authorization decision.
  // Each request still checks current publication, including conditional requests.
  let articleOwner;
  const checks = {
    settings: async () => {
      const settings = (await read("/items/site_settings?fields=background_image,background_images.directus_files_id")).data;
      return settings?.background_image === fileId || settings?.background_images?.some(row => row.directus_files_id === fileId);
    },
    posts: async () => (await rows("posts", { ...publicOnly(access.article || access.preview),
    _or: [{ cover_image: eq(fileId) }, { backgroundimage: eq(fileId) }]
    })).length > 0,
    article: async () => {
  // Match a whole asset ID, not a prefix of another file's URL.
  const reference = new RegExp(`/api/assets/${fileId}(?=$|[\\s)\\]<>\"'?/#])`);
  const file = (await read(`/files/${encodeURIComponent(fileId)}?fields=description`)).data;
  // A writer can type any UUID into Markdown. Only service-tagged article uploads
  // are article-owned; links must not promote private album or unrelated CMS files.
  if (/^article-image:[0-9a-f-]{36}$/i.test(file?.description || "")) {
    if (access.article) return true;
    if (hints.postId != null) {
      const posts = await rows("posts", { ...publicOnly(access.preview), id: eq(hints.postId) }, "id,content");
      if (posts.some(post => reference.test(post.content || ""))) { articleOwner = hints.postId; return true; }
    }
    // Never materialize one hundred multi-megabyte articles in an API response.
    // Discovery is bounded; subsequent checks use the owning post's primary key.
    for (let offset = 0; offset < 1000; offset++) {
      const posts = await rows("posts", { ...publicOnly(access.preview),
        content: { _contains: `/api/assets/${fileId}` }
      }, "id,content", 1, offset);
      const owner = posts.find(post => reference.test(post.content || ""));
      if (owner) { articleOwner = owner.id; return true; }
      if (!posts.length) return false;
    }
    throw Object.assign(new Error("Asset ownership lookup exceeded its query budget."), { statusCode: 503 });
  }
      return false;
    },
    videos: async () => (await rows("video_projects", { ...publicOnly(access.media || access.preview), cover_image: eq(fileId) })).length > 0,
    albums: async () => (await rows("albums", { ...publicOnly(access.media), cover_image: eq(fileId) })).length > 0,
    photos: async () => {
  const photoFilter = access.media ? {} : { published: eq(true), album_id: { published: eq(true) } };
      return (await rows("album_photos", { ...photoFilter, _or: [{ sdr_image: eq(fileId) }, { hdr_image: eq(fileId) }] })).length > 0;
    },
    renditions: async () => (await rows("album_photo_renditions", { file: eq(fileId), ...(access.media ? {} : {
      photo_id: { published: eq(true), album_id: { published: eq(true) } }
    }) })).length > 0
  };
  const order = [...new Set([hints.preferred, ...Object.keys(checks)])].filter(key => checks[key]);
  for (const owner of order) if (await checks[owner]()) { hints.onMatch?.(owner, articleOwner); return true; }
  return false;
}

/** Share simultaneous checks and bound misses; ownership hints preserve immediate revocation. */
function createAssetAuthorizer({ request, publicAssetIds = new Set(), maxEntries = 2048, negativeTtlMs = 2000, now = Date.now }) {
  const hints = new Map(), pending = new Map(), misses = new Map(), reads = new Map();
  const remember = (map, key, value) => {
    map.delete(key);
    if (map.size >= maxEntries) map.delete(map.keys().next().value);
    map.set(key, value);
  };
  const sharedRead = route => {
    // Concurrent images from one post share its current snapshot, never a retained grant.
    if (reads.has(route)) return reads.get(route);
    const work = (async () => request(route))().finally(() => reads.delete(route));
    reads.set(route, work); return work;
  };
  return async (id, access) => {
    const key = `${id}:${Boolean(access.media)}:${Boolean(access.article)}:${Boolean(access.preview)}`;
    if (publicAssetIds.has(id)) return true;
    if ((misses.get(key) || 0) > now()) return false;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxEntries) throw Object.assign(new Error("Asset authorization is busy."), { statusCode: 503 });
    const work = canReadAsset(id, access, sharedRead, publicAssetIds, {
      preferred: hints.get(key)?.owner, postId: hints.get(key)?.postId,
      onMatch: (owner, postId) => remember(hints, key, { owner, postId })
    }).then(allowed => {
      if (!allowed) remember(misses, key, now() + negativeTtlMs);
      return allowed;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
}

module.exports = { canReadAsset, createAssetAuthorizer };
