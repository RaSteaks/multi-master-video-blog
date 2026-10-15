export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 200;
export const SLUG_RECOMMENDED_LENGTH = 60;

/** Convert free text (a title or file name) into a valid slug; may return "" for non-Latin input. */
export function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

/** Slugify a file name without its extension, e.g. "Black_Hole v2.mov" -> "black-hole-v2". */
export function slugifyFileName(fileName: string) {
  return slugify(fileName.replace(/\.[^./\\]+$/, ""));
}

/**
 * Live-typing normalization: fixes case, separators and illegal characters as the user types,
 * but keeps a trailing hyphen so "dolby-" can still become "dolby-vision".
 */
export function sanitizeSlugInput(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX_LENGTH);
}

export function timestampSlug(prefix = "video", now = new Date()) {
  const stamp = now.toISOString().slice(0, 16).replace(/[-T:]/g, "");
  return `${prefix}-${stamp}`;
}
