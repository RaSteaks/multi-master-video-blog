import { describe, expect, it } from "vitest";
import { collectRevalidateTags } from "./revalidate-tags";

describe("collectRevalidateTags", () => {
  it("rejects valid JSON with a non-object root", () => {
    for (const body of [null, [], 1, "posts"]) {
      expect(collectRevalidateTags(body as never)).toEqual([]);
    }
  });
  it("maps posts updates to list and slug tags", () => {
    expect(
      collectRevalidateTags({
        collection: "posts",
        event: "items.update",
        payload: { id: 7, slug: "color-science" },
      }),
    ).toEqual(["posts:list", "posts:slug:color-science"]);
  });

  it("maps video_projects with the videos tag prefix", () => {
    expect(
      collectRevalidateTags({
        collection: "video_projects",
        payload: { slug: "hdr-2026" },
      }),
    ).toEqual(["videos:list", "videos:slug:hdr-2026"]);
  });

  it("still invalidates the list when no slug is available", () => {
    expect(
      collectRevalidateTags({
        collection: "video_projects",
        key: [12, 13],
      }),
    ).toEqual(["videos:list"]);
  });

  it("maps album_photos to the albums namespace", () => {
    expect(
      collectRevalidateTags({
        collection: "album_photos",
        payload: { id: 99, album_id: 5 },
      }),
    ).toEqual(["albums:list"]);
  });

  it("accepts normalized batch items", () => {
    expect(
      collectRevalidateTags({
        collection: "albums",
        items: [{ slug: "trip-2026" }, { slug: "trip-2026" }, { id: 3 }],
      }),
    ).toEqual(["albums:list", "albums:slug:trip-2026"]);
  });

  it("maps site_settings to the settings tag", () => {
    expect(collectRevalidateTags({ collection: "site_settings" })).toEqual([
      "site-settings",
    ]);
  });

  it("rejects unknown collections without emitting tags", () => {
    expect(collectRevalidateTags({ collection: "users" })).toEqual([]);
    expect(collectRevalidateTags({})).toEqual([]);
    expect(collectRevalidateTags({ collection: null })).toEqual([]);
  });

  it("sanitizes hostile slug input instead of minting arbitrary tags", () => {
    expect(
      collectRevalidateTags({
        collection: "posts",
        payload: { slug: "a b/c:d;DROP" },
      }),
    ).toEqual(["posts:list", "posts:slug:abcdDROP"]);
  });

  it("ignores non-object payload and item shapes", () => {
    expect(
      collectRevalidateTags({
        collection: "posts",
        items: ["not-an-object", 42],
        payload: "nope",
        key: "not-a-real-shape-but-harmless",
      }),
    ).toEqual(["posts:list"]);
  });
});
