/**
 * What a view-transition navigation does once its wait ends:
 *   shared   content and every shared element it morphs are ready — full transition
 *   content  content is ready but the cover is not — plain cross-fade, cover loads on its own
 *   skip     still a skeleton or not yet committed — skip, the veil plays when content arrives
 */
export type RouteReadiness = "shared" | "content" | "skip";

/**
 * `coverReady` is null when the navigation morphs no cover. Returns null while
 * it is still worth waiting: before the budget expires, only a fully ready
 * destination ends the wait early.
 */
export function routeReadiness({
  committed,
  loading,
  coverReady,
  expired,
}: {
  committed: boolean;
  loading: boolean;
  coverReady: boolean | null;
  expired: boolean;
}): RouteReadiness | null {
  const contentReady = committed && !loading;
  if (contentReady && coverReady !== false) return "shared";
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
  about: 4,
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
