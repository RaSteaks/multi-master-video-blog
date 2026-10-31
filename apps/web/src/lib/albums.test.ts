import { afterEach, describe, expect, it, vi } from "vitest";
import {
  albumPictureSources,
  albumThumbSrcSet,
  assetUrl,
  filterPublishedAlbums,
  getAlbum,
  siteBackgroundImages,
  type Album,
  type AlbumPhoto,
} from "./directus";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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
    film_scan_frame_id: null,
    film_stock: null,
    film_process: null,
    film_scanner: null,
    film_frame_format: null,
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
  it("uses only managed named presets", () => {
    expect(assetUrl("file-id")).toBe("/api/assets/file-id");
    expect(assetUrl("file-id", "album-cover")).toBe(
      "/api/assets/file-id?key=album-cover",
    );
    expect(assetUrl("file-id", "album-thumb")).toBe(
      "/api/assets/file-id?key=album-thumb",
    );
    expect(assetUrl("file-id", "site-background")).toBe(
      "/api/assets/file-id?key=site-background",
    );
    expect(() =>
      assetUrl("file-id", "arbitrary" as "album-thumb"),
    ).toThrow(/Unsupported asset preset/);
  });

  it("creates deduplicated full and thumbnail background URLs", () => {
    expect(
      siteBackgroundImages({
        background_image: "background-a",
        background_blur: 8,
        background_images: [
          { directus_files_id: "background-a" },
          { directus_files_id: "background-b" },
        ],
      }),
    ).toEqual([
      {
        url: "/api/assets/background-a?key=site-background",
        thumbnailUrl: "/api/assets/background-a?key=site-background-thumb",
      },
      {
        url: "/api/assets/background-b?key=site-background",
        thumbnailUrl: "/api/assets/background-b?key=site-background-thumb",
      },
    ]);
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

describe("album thumbnail srcset", () => {
  it("reports the real pixel width of each inside-fit preset", () => {
    expect(albumThumbSrcSet("f", { width: 2220, height: 3106 })).toBe(
      "/api/assets/f?key=album-thumb-sm 429w, /api/assets/f?key=album-thumb 858w",
    );
    expect(albumThumbSrcSet("f", { width: 4000, height: 3000 })).toBe(
      "/api/assets/f?key=album-thumb-sm 600w, /api/assets/f?key=album-thumb 1200w",
    );
  });

  it("never advertises sizes larger than the source file", () => {
    expect(albumThumbSrcSet("f", { width: 400, height: 300 })).toBe(
      "/api/assets/f?key=album-thumb-sm 400w",
    );
  });

  it("is omitted when dimensions or the file are unknown", () => {
    expect(albumThumbSrcSet("f", null)).toBeNull();
    expect(albumThumbSrcSet(null, { width: 10, height: 10 })).toBeNull();
    expect(albumThumbSrcSet("f", { width: 0, height: 10 })).toBeNull();
    expect(albumThumbSrcSet("f", { width: 10, height: NaN })).toBeNull();
  });
});

describe("album SDR dimensions", () => {
  function mockAlbumFiles(count: number, failedBatch = 0) {
    // Real UUID lengths exercise request limits rather than short fixture IDs.
    const photos = Array.from({ length: count }, (_, index) => photo(index + 1, true, {
      sdr_image: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const requestedIds: string[] = [];
    const requestPaths: string[] = [];
    let batch = 0;
    vi.stubEnv("DIRECTUS_EMAIL", "");
    vi.stubEnv("DIRECTUS_PASSWORD", "");
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === "/items/albums") {
        return Response.json({ data: [album(1, true, photos)] });
      }
      if (url.pathname === "/items/album_photos") {
        // Match the new bounded gallery pagination before checking dimension batches.
        const offset = Number(url.searchParams.get("offset") || 0);
        expect(url.searchParams.get("limit")).toBe("100");
        return Response.json({ data: photos.slice(offset, offset + 100) });
      }
      expect(url.pathname).toBe("/files");
      requestPaths.push(url.pathname + url.search);
      const ids = url.searchParams.get("filter[id][_in]")!.split(",");
      requestedIds.push(...ids);
      if (++batch === failedBatch) {
        return Response.json({ errors: [] }, { status: 431 });
      }
      return Response.json({ data: ids.map((id) => ({ id, width: 4000, height: 3000 })) });
    }));
    return { requestedIds, requestPaths };
  }

  it("keeps every lookup URL bounded while attaching dimensions to a large album", async () => {
    const requests = mockAlbumFiles(500);
    const result = await getAlbum("album-1");
    expect(result?.photos).toHaveLength(500);
    expect(requests.requestPaths.length).toBeGreaterThan(1);
    expect(requests.requestPaths.every((pathname) => pathname.length < 3000)).toBe(true);
    expect(new Set(requests.requestedIds).size).toBe(500);
    expect(result?.photos?.every((item) => item.sdr_dimensions?.width === 4000)).toBe(true);
  });

  it("logs a failed batch and retains dimensions from the other batches", async () => {
    mockAlbumFiles(121, 2);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await getAlbum("album-1");
    expect(result?.photos).toHaveLength(121);
    expect(result?.photos?.[0].sdr_dimensions).toEqual({ width: 4000, height: 3000 });
    expect(result?.photos?.[50].sdr_dimensions).toBeNull();
    expect(result?.photos?.[100].sdr_dimensions).toEqual({ width: 4000, height: 3000 });
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0][0]).toMatch(/SDR dimensions batch 2 failed/);
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
      hlg: null,
    });
    expect(
      albumPictureSources(
        photo(3, true, {
          sdr_image: "sdr",
          hdr_image: "pq",
          renditions: [
            {
              id: 1,
              kind: "hlg",
              file: "hlg",
              transfer: "hlg",
              primaries: "bt2020",
              bit_depth: 10,
              is_default: false,
            },
          ],
        }),
      ).hlg,
    ).toBe("/api/assets/hlg");
    expect(
      albumPictureSources(
        photo(2, true, { sdr_image: "sdr-only", hdr_image: null }),
      ).hdr,
    ).toBeNull();
  });
});
