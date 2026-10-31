import { describe, expect, it } from "vitest";
import {
  canSpeculativelyPreload,
  createImagePreloader,
  neighborIndices,
  photoChangeKind,
  photoRangeSource,
  preferredPhotoRange,
  type PreloadImage,
} from "./lightbox-media";

const hdrPhoto = { sdrUrl: "/api/assets/s", hdrUrl: "/api/assets/p", hlgUrl: "/api/assets/h" };
const sdrPhoto = { sdrUrl: "/api/assets/s2", hdrUrl: null, hlgUrl: null };

describe("display version", () => {
  it("starts HDR displays on PQ, then HLG, and everything else on SDR", () => {
    expect(preferredPhotoRange(hdrPhoto, { hdrDisplay: true })).toBe("PQ");
    expect(preferredPhotoRange(hdrPhoto, { hdrDisplay: true, pqFailed: true })).toBe("HLG");
    expect(preferredPhotoRange(hdrPhoto, { hdrDisplay: true, pqFailed: true, hlgFailed: true })).toBe("SDR");
    expect(preferredPhotoRange(hdrPhoto, { hdrDisplay: false })).toBe("SDR");
    expect(preferredPhotoRange(sdrPhoto, { hdrDisplay: true })).toBe("SDR");
  });

  it("resolves the file for a range, keeping the SDR fallback for failed files", () => {
    expect(photoRangeSource(hdrPhoto, "PQ")).toBe("/api/assets/p");
    expect(photoRangeSource(hdrPhoto, "PQ", { pqFailed: true })).toBe("/api/assets/s");
    expect(photoRangeSource(hdrPhoto, "HLG")).toBe("/api/assets/h");
    expect(photoRangeSource(sdrPhoto, "PQ")).toBe("/api/assets/s2");
  });
});

describe("photo change", () => {
  it("loops neighbours without duplicating them in small albums", () => {
    expect(neighborIndices(0, 5)).toEqual([1, 4]);
    expect(neighborIndices(4, 5)).toEqual([0, 3]);
    expect(neighborIndices(0, 2)).toEqual([1]);
    expect(neighborIndices(0, 1)).toEqual([]);
  });

  it("cross-fades only between different SDR photos with motion allowed", () => {
    const sdr = (photoId: number) => ({ photoId, range: "SDR" as const });
    expect(photoChangeKind({ from: sdr(1), to: sdr(2), reducedMotion: false })).toBe("crossfade");
    expect(photoChangeKind({ from: sdr(1), to: sdr(2), reducedMotion: true })).toBe("cut");
    expect(photoChangeKind({ from: sdr(1), to: { photoId: 1, range: "PQ" }, reducedMotion: false })).toBe("cut");
    expect(photoChangeKind({ from: { photoId: 1, range: "HLG" }, to: sdr(2), reducedMotion: false })).toBe("cut");
  });

  it("skips speculative downloads for Save-Data and 2G", () => {
    expect(canSpeculativelyPreload(undefined)).toBe(true);
    expect(canSpeculativelyPreload({ saveData: true })).toBe(false);
    expect(canSpeculativelyPreload({ effectiveType: "slow-2g" })).toBe(false);
    expect(canSpeculativelyPreload({ effectiveType: "2g" })).toBe(false);
    expect(canSpeculativelyPreload({ effectiveType: "4g" })).toBe(true);
  });
});

function fakeImages() {
  const created: Array<PreloadImage & { aborted: boolean; requested: string }> = [];
  return {
    created,
    createImage() {
      const image = {
        aborted: false,
        requested: "",
        decoding: "",
        fetchPriority: "",
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
        decode: () => Promise.resolve(),
        set src(value: string) {
          if (value === "" && this.requested) this.aborted = true;
          else this.requested = value;
        },
        get src() {
          return this.requested;
        },
      };
      created.push(image);
      return image;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("neighbour preloader", () => {
  it("bounds concurrency and starts queued work as requests settle", async () => {
    const images = fakeImages();
    const preloader = createImagePreloader({ concurrency: 2, createImage: images.createImage });
    preloader.want(["/a", "/b", "/c"]);
    expect(images.created.map((image) => image.requested)).toEqual(["/a", "/b"]);
    images.created[0].onload?.();
    await flush();
    expect(preloader.status("/a")).toBe("ready");
    expect(images.created.map((image) => image.requested)).toEqual(["/a", "/b", "/c"]);
  });

  it("cancels stale in-flight requests when the wanted set moves on", () => {
    const images = fakeImages();
    const preloader = createImagePreloader({ createImage: images.createImage });
    preloader.want(["/a", "/b"]);
    preloader.want(["/c", "/d"]);
    expect(images.created[0].aborted).toBe(true);
    expect(images.created[1].aborted).toBe(true);
    expect(preloader.status("/a")).toBeUndefined();
    expect(images.created.slice(2).map((image) => image.requested)).toEqual(["/c", "/d"]);
  });

  it("evicts least recent unwanted decoded images beyond capacity", async () => {
    const images = fakeImages();
    const preloader = createImagePreloader({ concurrency: 4, capacity: 2, createImage: images.createImage });
    preloader.want(["/a", "/b"]);
    images.created.forEach((image) => image.onload?.());
    await flush();
    preloader.want(["/c"]);
    images.created[2].onload?.();
    await flush();
    expect(preloader.status("/c")).toBe("ready");
    expect(preloader.status("/a")).toBeUndefined();
    expect(preloader.status("/b")).toBe("ready");
  });

  it("records failures without retrying and releases everything on dispose", async () => {
    const images = fakeImages();
    const preloader = createImagePreloader({ createImage: images.createImage });
    preloader.want(["/broken", "/slow"]);
    images.created[0].onerror?.();
    preloader.want(["/broken", "/slow"]);
    expect(preloader.status("/broken")).toBe("failed");
    expect(images.created).toHaveLength(2);
    preloader.dispose();
    expect(images.created[1].aborted).toBe(true);
    expect(preloader.status("/slow")).toBeUndefined();
    preloader.want(["/later"]);
    expect(images.created).toHaveLength(2);
  });
});
