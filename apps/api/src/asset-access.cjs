// CMS credentials authorize the service, not the anonymous caller. Check the owning
// content on every request, including conditional requests, so unpublishing revokes access.
async function canReadAsset(fileId, access, request, publicAssetIds = new Set()) {
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
  const settings = (await read("/items/site_settings?fields=background_image,background_images.directus_files_id")).data;
  if (settings?.background_image === fileId ||
      settings?.background_images?.some(row => row.directus_files_id === fileId)) return true;

  if ((await rows("posts", { ...publicOnly(access.article || access.preview),
    _or: [{ cover_image: eq(fileId) }, { backgroundimage: eq(fileId) }]
  })).length) return true;
  // Match a whole asset ID, not a prefix of another file's URL.
  const reference = new RegExp(`/api/assets/${fileId}(?=$|[\\s)\\]<>\"'?/#])`);
  const file = (await read(`/files/${encodeURIComponent(fileId)}?fields=description`)).data;
  // A writer can type any UUID into Markdown. Only service-tagged article uploads
  // are article-owned; links must not promote private album or unrelated CMS files.
  if (/^article-image:[0-9a-f-]{36}$/i.test(file?.description || "")) {
    if (access.article) return true;
    for (let offset = 0; ; offset += 100) {
      const posts = await rows("posts", { ...publicOnly(access.preview),
        content: { _contains: `/api/assets/${fileId}` }
      }, "content", 100, offset);
      if (posts.some(post => reference.test(post.content || ""))) return true;
      if (posts.length < 100) break;
    }
  }

  if ((await rows("video_projects", { ...publicOnly(access.media || access.preview), cover_image: eq(fileId) })).length) return true;
  if ((await rows("albums", { ...publicOnly(access.media), cover_image: eq(fileId) })).length) return true;
  const photoFilter = access.media ? {} : { published: eq(true), album_id: { published: eq(true) } };
  if ((await rows("album_photos", { ...photoFilter, _or: [{ sdr_image: eq(fileId) }, { hdr_image: eq(fileId) }] })).length) return true;
  return (await rows("album_photo_renditions", { file: eq(fileId), ...(access.media ? {} : { photo_id: photoFilter }) })).length > 0;
}

module.exports = { canReadAsset };
