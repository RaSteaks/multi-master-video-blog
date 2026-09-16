/**
 * Cache-tag mapping for POST /internal/revalidate (Directus webhooks).
 *
 * Only tags that are actually attached to fetches in lib/directus.ts are
 * emitted — invalidating unused tags is a no-op that hides wiring mistakes:
 *
 *   posts:list / posts:slug:<slug>      getPosts / getPost
 *   videos:list / videos:slug:<slug>    getVideoProjects / getVideoProject
 *   albums:list / albums:slug:<slug>    getAlbums / getAlbum
 *   site-settings                       getSiteSettings
 *
 * Detail fetches also carry their collection list tag. Partial updates,
 * deletes, slug changes and album photo changes invalidate all details in
 * that collection. Slug tags are additional hints, not required for correctness.
 */

export type RevalidateItem = {
  id?: string | number;
  slug?: string;
  albumId?: string | number;
};

export type RevalidateRequest = {
  collection?: unknown;
  event?: unknown;
  items?: unknown;
  payload?: unknown;
  key?: unknown;
};

const COLLECTION_TAG_PREFIX: Record<string, "posts" | "videos" | "albums"> = {
  posts: "posts",
  video_projects: "videos",
  videos: "videos",
  albums: "albums",
  album_photos: "albums",
};

export const REVALIDATE_COLLECTIONS = [
  "posts",
  "video_projects",
  "albums",
  "album_photos",
  "site_settings",
] as const;

/** Normalize the accepted webhook shapes into known tags. Untrusted input is
 *  never interpolated into a tag — unknown collections yield no tags. */
export function collectRevalidateTags(body: RevalidateRequest): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const collection =
    typeof body.collection === "string" ? body.collection : null;

  if (collection === "site_settings") {
    return ["site-settings"];
  }

  const prefix = collection ? COLLECTION_TAG_PREFIX[collection] : undefined;
  if (!prefix) return [];

  const tags = new Set<string>([`${prefix}:list`]);
  const items = normalizeItems(body);

  for (const item of items) {
    if (typeof item.slug === "string" && item.slug) {
      // Slugs become tag suffixes; keep the tag shape conservative so a
      // hostile webhook body cannot mint arbitrary-looking tags that might
      // collide with future tag namespaces.
      tags.add(`${prefix}:slug:${sanitizeTagToken(item.slug)}`);
    }
  }

  return [...tags];
}

function normalizeItems(body: RevalidateRequest): RevalidateItem[] {
  const items: RevalidateItem[] = [];

  if (Array.isArray(body.items)) {
    for (const entry of body.items) {
      if (entry && typeof entry === "object") {
        items.push(entry as RevalidateItem);
      }
    }
  }

  // Directus item webhooks send `payload` (full item when enabled) and/or
  // `key` (primary key or array of keys).
  if (body.payload && typeof body.payload === "object") {
    items.push(body.payload as RevalidateItem);
  }

  if (body.key != null) {
    const keys = Array.isArray(body.key) ? body.key : [body.key];
    for (const key of keys) {
      if (key != null) items.push({ id: key as string | number });
    }
  }

  return items;
}

function sanitizeTagToken(value: string): string {
  return value.slice(0, 128).replace(/[^\w.-]/g, "");
}
