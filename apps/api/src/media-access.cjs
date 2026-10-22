const path = require("node:path");

function localMediaPath(value) {
  if (typeof value !== "string" || !value.startsWith("/media/")) return null;
  try { return decodeURIComponent(new URL(value, "http://media.invalid").pathname); }
  catch { return null; }
}

/** Verify a current CMS owner before serving public bytes or a 304 response. */
async function canReadMedia(relative, access, request, publicFiles = new Set()) {
  if (access.media || publicFiles.has(relative)) return true;
  const pathname = `/media/${relative}`;
  const encoded = `/media/${relative.split("/").map(encodeURIComponent).join("/")}`;
  const slug = relative.split("/")[0];
  const params = new URLSearchParams({ fields: "hls_url,file_url", limit: "100", sort: "id",
    "filter[project_id][slug][_eq]": slug, "filter[project_id][published][_eq]": "true",
    "filter[status][_eq]": "ready", "filter[verification_status][_eq]": "ready" });
  // Pagination bounds each response while supporting projects with many historical masters.
  for (let offset = 0; ; offset += 100) {
    params.set("offset", String(offset));
    const rows = (await request(`/items/video_masters?${params}`)).data || [];
    for (const row of rows) {
      if (localMediaPath(row.file_url) === pathname) return true;
      const hls = localMediaPath(row.hls_url);
      // A legacy root playlist must not implicitly publish sibling source archives.
      const archive = ["source", "source-package"].includes(relative.split("/")[1]?.toLowerCase());
      if (!archive && hls?.startsWith(`/media/${slug}/`) && pathname.startsWith(path.posix.dirname(hls) + "/") &&
          [".m3u8", ".m4s", ".ts", ".mp4", ".aac", ".vtt", ".key"].includes(path.posix.extname(relative).toLowerCase())) return true;
    }
    if (rows.length < 100) break;
  }
  // Article embeds can publish their own passive assets, never video source archives.
  if (!/\.(sog|ply|png|jpe?g|webp|avif)$/i.test(relative) || /\/(source|source-package)\//i.test(relative)) return false;
  const escaped = [...new Set([pathname, encoded])].map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const reference = new RegExp(`(?:${escaped})(?=$|[\\s)\\]<>"'?/#])`);
  const posts = new URLSearchParams({ fields: "content", limit: "100", sort: "id",
    filter: JSON.stringify({ published: { _eq: true }, _or: [
      { content: { _contains: pathname } }, { content: { _contains: encoded } }
    ] }) });
  for (let offset = 0; ; offset += 100) {
    posts.set("offset", String(offset));
    const rows = (await request(`/items/posts?${posts}`)).data || [];
    if (rows.some(row => reference.test(row.content || ""))) return true;
    if (rows.length < 100) return false;
  }
}

module.exports = { canReadMedia };
