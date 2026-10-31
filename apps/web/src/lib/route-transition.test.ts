import { describe, expect, it } from "vitest";
import { routeReadiness, wipeDirection } from "./route-transition";

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

describe("wipe direction", () => {
  it("follows the nav order between sections", () => {
    expect(wipeDirection("/albums", "/project")).toBe("forward");
    expect(wipeDirection("/about", "/project")).toBe("back");
    expect(wipeDirection("/videos", "/posts")).toBe("forward");
    expect(wipeDirection("/about", "/albums")).toBe("back");
    expect(wipeDirection("/", "/about")).toBe("forward");
    expect(wipeDirection("/posts/a", "/")).toBe("back");
  });

  it("treats sub-sections as their nav section", () => {
    expect(wipeDirection("/write", "/videos")).toBe("back");
    expect(wipeDirection("/upload", "/posts")).toBe("forward");
    expect(wipeDirection("/write", "/posts")).toBe("forward");
  });

  it("goes forward into a detail page and back up to its list", () => {
    expect(wipeDirection("/posts", "/posts/a")).toBe("forward");
    expect(wipeDirection("/posts/a", "/posts")).toBe("back");
    expect(wipeDirection("/posts/a", "/posts/b")).toBe("forward");
  });

  it("falls back to depth for unknown sections", () => {
    expect(wipeDirection("/internal", "/posts")).toBe("forward");
    expect(wipeDirection("/internal/x", "/posts")).toBe("back");
  });
});
