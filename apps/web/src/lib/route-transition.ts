/**
 * What a view-transition navigation does once its wait ends:
 *   shared   content, first-screen media and every shared element it morphs are ready — full transition
 *   content  content is ready but the cover is not — wipe only, cover loads on its own
 *   skip     still loading — release native snapshots and switch without a delayed decorative wipe
 */
export type RouteReadiness = "shared" | "content" | "skip";

/**
 * `coverReady` is null when the navigation morphs no cover. `mediaReady` also
 * turns true when its own short budget runs out, so a slow image delays the wipe
 * but never cancels it. Returns null while it is still worth waiting: before the
 * budget expires, only a fully ready destination ends the wait early.
 */
export function routeReadiness({
  committed,
  loading,
  coverReady,
  mediaReady,
  expired,
}: {
  committed: boolean;
  loading: boolean;
  coverReady: boolean | null;
  mediaReady: boolean;
  expired: boolean;
}): RouteReadiness | null {
  const contentReady = committed && !loading;
  if (contentReady && coverReady !== false && mediaReady) return "shared";
  if (!expired) return null;
  return contentReady ? "content" : "skip";
}

export type WipeDirection = "forward" | "back";

// Top-level sections in navigation order; sub-sections ride with the section
// whose nav item they highlight (upload → videos, write → posts).
const SECTION_ORDER: Record<string, number> = {
  "": 0,
  videos: 1,
  upload: 1,
  posts: 2,
  write: 2,
  albums: 3,
  project: 4,
  about: 5,
};

/**
 * Which way the navigation wipe sweeps: toward a later nav section or deeper
 * into the same section is "forward" (the divider moves left → right), toward
 * an earlier section or back up to a list is "back".
 */
export function wipeDirection(fromPathname: string, toPathname: string): WipeDirection {
  const from = fromPathname.split("/").filter(Boolean);
  const to = toPathname.split("/").filter(Boolean);
  const fromOrder = SECTION_ORDER[from[0] ?? ""];
  const toOrder = SECTION_ORDER[to[0] ?? ""];
  if (fromOrder !== undefined && toOrder !== undefined && fromOrder !== toOrder) {
    return toOrder < fromOrder ? "back" : "forward";
  }
  return to.length < from.length ? "back" : "forward";
}
