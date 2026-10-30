import { describe, expect, it } from "vitest";
import { liquidReadingScale, playbackLinkTime } from "./viewing";
import { authorReturnPath } from "./author-navigation";
import { collectRevalidateTags } from "./revalidate-tags";

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
    expect(authorReturnPath("/albums?dialog=upload#photos")).toBe("/albums?dialog=upload#photos");
    for (const next of [undefined, ["/albums"], "https://example.com", "//example.com", "/\\example.com", "/\n/example.com"]) expect(authorReturnPath(next)).toBe("/");
  });
  it("invalidates featured projects for publication, order and deletion webhooks", () => {
    for (const event of ["items.create", "items.update", "items.delete"]) expect(collectRevalidateTags({ collection: "external_projects", event, key: 7 })).toEqual(["projects:list"]);
  });
});
