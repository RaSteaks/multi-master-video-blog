import { describe, expect, it } from "vitest";
import {
  albumPictureSources,
  assetUrl,
  filterPublishedAlbums,
  type Album,
  type AlbumPhoto,
} from "./directus";

function photo(
  id: number,
  published: boolean,
  overrides: Partial<AlbumPhoto> = {},
): AlbumPhoto {
  return {
    id,
    album_id: 1,
    sdr_image: `sdr-${id}`,
    hdr_image: null,
    caption: null,
    alt_text: null,
    hdr_transfer: null,
    hdr_primaries: null,
    hdr_bit_depth: null,
    published,
    sort_order: id,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function album(
  id: number,
  published: boolean,
  photos: AlbumPhoto[],
): Album {
  return {
    id,
    title: `Album ${id}`,
    slug: `album-${id}`,
    description: null,
    cover_image: photos[0]?.sdr_image ?? null,
    published,
    created_at: null,
    updated_at: null,
    photos,
  };
}

describe("album asset URLs", () => {
  it("uses only the named cover and thumbnail presets", () => {
    expect(assetUrl("file-id")).toBe("/api/assets/file-id");
    expect(assetUrl("file-id", "album-cover")).toBe(
      "/api/assets/file-id?key=album-cover",
    );
    expect(assetUrl("file-id", "album-thumb")).toBe(
      "/api/assets/file-id?key=album-thumb",
    );
    expect(() =>
      assetUrl("file-id", "arbitrary" as "album-thumb"),
    ).toThrow(/Unsupported asset preset/);
  });
});

describe("public album filtering", () => {
  it("removes draft albums and draft photos, then keeps photo order", () => {
    const result = filterPublishedAlbums([
      album(1, true, [
        photo(3, true, { sort_order: 2 }),
        photo(1, false, { sort_order: 0 }),
        photo(2, true, { sort_order: 1 }),
      ]),
      album(2, false, [photo(4, true)]),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].photos?.map((item) => item.id)).toEqual([2, 3]);
  });
});

describe("HDR picture sources", () => {
  it("always supplies SDR and only adds HDR when a pair exists", () => {
    expect(
      albumPictureSources(
        photo(1, true, { sdr_image: "sdr", hdr_image: "hdr" }),
      ),
    ).toEqual({
      thumbnail: "/api/assets/sdr?key=album-thumb",
      sdr: "/api/assets/sdr",
      hdr: "/api/assets/hdr",
    });
    expect(
      albumPictureSources(
        photo(2, true, { sdr_image: "sdr-only", hdr_image: null }),
      ).hdr,
    ).toBeNull();
  });
});
