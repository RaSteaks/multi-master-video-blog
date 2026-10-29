import { describe, expect, it } from "vitest";
import { routeReadiness } from "./route-transition";

describe("route readiness", () => {
  const base = { committed: true, loading: false, coverReady: null, expired: false };

  it("ends the wait early once content and the cover are ready", () => {
    expect(routeReadiness(base)).toBe("shared");
    expect(routeReadiness({ ...base, coverReady: true })).toBe("shared");
  });

  it("keeps waiting within the budget", () => {
    expect(routeReadiness({ ...base, committed: false })).toBeNull();
    expect(routeReadiness({ ...base, loading: true })).toBeNull();
    expect(routeReadiness({ ...base, coverReady: false })).toBeNull();
  });

  it("drops only the cover morph when the cover is not decoded in time", () => {
    expect(routeReadiness({ ...base, coverReady: false, expired: true })).toBe("content");
  });

  it("skips the transition while a skeleton shows or the route has not committed", () => {
    expect(routeReadiness({ ...base, loading: true, expired: true })).toBe("skip");
    expect(routeReadiness({ ...base, committed: false, expired: true })).toBe("skip");
    expect(routeReadiness({ ...base, committed: false, coverReady: false, expired: true })).toBe("skip");
  });
});
