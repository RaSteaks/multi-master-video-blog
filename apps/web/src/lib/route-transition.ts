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
