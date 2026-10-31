import { describe, expect, it } from "vitest";
import { liquidReadingScale, liquidRouteActive, playbackLinkTime } from "./viewing";
import { authorReturnPath } from "./author-navigation";

describe("viewing and author navigation boundaries", () => {
  it("slows only article/video details", () => {
    for (const path of ["/posts/color", "/videos/master", "/videos/master/"]) expect(liquidReadingScale(path)).toBe(0.35);
    for (const path of ["/", "/posts", "/videos", "/albums/color", "/posts/a/b"]) expect(liquidReadingScale(path)).toBe(1);
  });
  it("reads seconds while rejecting malformed and non-finite times", () => {
    expect(playbackLinkTime("123.5")).toBe(123.5);
    for (const time of [null, "", "-2", "Infinity", "NaN", "1:30", "1e3", "9".repeat(400)]) expect(playbackLinkTime(time)).toBe(0);
  });
  it("allows local return URLs without accepting URL-normalized external destinations", () => {
    expect(authorReturnPath("/posts/../albums?dialog=upload#photos")).toBe("/albums?dialog=upload#photos");
    expect(authorReturnPath("/albums?dialog=upload#photos")).toBe("/albums?dialog=upload#photos");
    for (const next of [undefined, ["/albums"], "https://example.com", "//example.com", "/\\example.com", "/\n/example.com", "/.//evil.com", "/%2e//evil.com", "/a/..//evil.com"]) expect(authorReturnPath(next)).toBe("/");
  });
});

describe("liquid background routes", () => {
  it("runs on the sections painted over it, including their detail pages", () => {
    for (const path of ["/", "/videos", "/posts/a", "/albums/b", "/project", "/write", "/upload"]) expect(liquidRouteActive(path)).toBe(true);
  });

  it("stays off elsewhere", () => {
    for (const path of ["/about", "/studio", "/videosx"]) expect(liquidRouteActive(path)).toBe(false);
  });
});
