export const READING_SPEED_SCALE = 0.35;

/** Sections painted over the liquid layer. Elsewhere it shows only in explicit liquid mode. */
const LIQUID_SECTIONS = new Set(["", "videos", "posts", "albums", "project", "write", "upload"]);

export function liquidRouteActive(pathname: string) {
  return LIQUID_SECTIONS.has(pathname.split("/")[1] ?? "");
}

export function liquidReadingScale(pathname: string) {
  return /^\/(posts|videos)\/[^/]+\/?$/.test(pathname) ? READING_SPEED_SCALE : 1;
}

/** Seconds only: reject negative, non-finite and ambiguous formatted timestamps. */
export function playbackLinkTime(value: string | null) {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : 0;
}
