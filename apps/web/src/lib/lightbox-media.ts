/**
 * Display-version selection and bounded neighbour preloading for the album lightbox.
 * Selection mirrors the lightbox's existing rules so a preloaded file is the one
 * the lightbox will actually request.
 */
export type PhotoRange = "PQ" | "HLG" | "SDR";

type RangePhoto = { sdrUrl: string; hdrUrl: string | null; hlgUrl: string | null };
type RangeFailures = { pqFailed?: boolean; hlgFailed?: boolean };

/** HDR displays start on PQ, then HLG; every other display, or a failed HDR file, uses SDR. */
export function preferredPhotoRange(
  photo: RangePhoto,
  { hdrDisplay, pqFailed = false, hlgFailed = false }: RangeFailures & { hdrDisplay: boolean },
): PhotoRange {
  if (hdrDisplay && photo.hdrUrl && !pqFailed) return "PQ";
  if (hdrDisplay && photo.hlgUrl && !hlgFailed) return "HLG";
  return "SDR";
}

export function photoRangeSource(
  photo: RangePhoto,
  range: PhotoRange,
  { pqFailed = false, hlgFailed = false }: RangeFailures = {},
) {
  if (range === "PQ" && photo.hdrUrl && !pqFailed) return photo.hdrUrl;
  if (range === "HLG" && photo.hlgUrl && !hlgFailed) return photo.hlgUrl;
  return photo.sdrUrl;
}

/** Next and previous in a looping album, without duplicates for tiny albums. */
export function neighborIndices(index: number, total: number) {
  if (total <= 1 || index < 0 || index >= total) return [];
  const next = (index + 1) % total;
  const previous = (index - 1 + total) % total;
  return next === previous ? [next] : [next, previous];
}

export type PhotoChange = "crossfade" | "cut";

/**
 * Different SDR photos may cross-fade. A range comparison (same photo) or any HDR
 * side cuts, so two renderings are never blended into a picture neither file contains.
 */
export function photoChangeKind({
  from,
  to,
  reducedMotion,
}: {
  from: { photoId: number; range: PhotoRange };
  to: { photoId: number; range: PhotoRange };
  reducedMotion: boolean;
}): PhotoChange {
  if (reducedMotion || from.photoId === to.photoId) return "cut";
  return from.range === "SDR" && to.range === "SDR" ? "crossfade" : "cut";
}

type ConnectionHint = { saveData?: boolean; effectiveType?: string };

/** Speculative downloads honour Save-Data and very slow connections. */
export function canSpeculativelyPreload(connection: ConnectionHint | null | undefined) {
  if (!connection) return true;
  if (connection.saveData) return false;
  return !/(^|-)2g$/.test(connection.effectiveType || "");
}

export type PreloadImage = {
  src: string;
  decoding?: string;
  fetchPriority?: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  decode?: () => Promise<void>;
};

type PreloadEntry = { image: PreloadImage; state: "loading" | "ready" | "failed" };

export type ImagePreloader = {
  /** Replace the wanted set: stale queued or in-flight requests are cancelled. */
  want(urls: string[]): void;
  status(url: string): PreloadEntry["state"] | undefined;
  /** Cancel everything and drop decoded references (lightbox closed). */
  dispose(): void;
};

/**
 * Public, anonymous assets only — protected (token) images must keep using their
 * authenticated fetch path and are never handed to this preloader.
 */
export function createImagePreloader({
  concurrency = 2,
  capacity = 4,
  createImage,
}: {
  concurrency?: number;
  capacity?: number;
  createImage: () => PreloadImage;
}): ImagePreloader {
  // Map order is the LRU order: oldest first.
  const entries = new Map<string, PreloadEntry>();
  let queue: string[] = [];
  let wanted = new Set<string>();
  let disposed = false;

  const inFlight = () => [...entries.values()].filter((entry) => entry.state === "loading").length;

  function cancel(url: string) {
    const entry = entries.get(url);
    if (!entry) return;
    entry.image.onload = null;
    entry.image.onerror = null;
    // Clearing src aborts the request in every current engine.
    if (entry.state === "loading") entry.image.src = "";
    entries.delete(url);
  }

  function trim() {
    for (const [url, entry] of entries) {
      if (entries.size <= capacity) break;
      if (entry.state !== "loading" && !wanted.has(url)) cancel(url);
    }
  }

  function settle(url: string, entry: PreloadEntry, state: "ready" | "failed") {
    if (disposed || entries.get(url) !== entry) return;
    entry.state = state;
    // Refresh recency so wanted images are the last to be evicted.
    entries.delete(url);
    entries.set(url, entry);
    trim();
    pump();
  }

  function start(url: string) {
    const image = createImage();
    const entry: PreloadEntry = { image, state: "loading" };
    entries.set(url, entry);
    image.decoding = "async";
    image.fetchPriority = "low";
    image.onerror = () => settle(url, entry, "failed");
    image.onload = () => {
      // decode() keeps the bitmap warm; a decode rejection still leaves a loaded file.
      const decoded = image.decode?.() ?? Promise.resolve();
      decoded.then(() => settle(url, entry, "ready"), () => settle(url, entry, "ready"));
    };
    image.src = url;
  }

  function pump() {
    if (disposed) return;
    while (queue.length && inFlight() < concurrency) {
      const url = queue.shift()!;
      if (!entries.has(url)) start(url);
    }
  }

  return {
    want(urls) {
      if (disposed) return;
      wanted = new Set(urls);
      for (const [url, entry] of [...entries]) {
        if (entry.state === "loading" && !wanted.has(url)) cancel(url);
      }
      queue = urls.filter((url, index) => urls.indexOf(url) === index && !entries.has(url));
      trim();
      pump();
    },
    status(url) {
      return entries.get(url)?.state;
    },
    dispose() {
      disposed = true;
      queue = [];
      for (const url of [...entries.keys()]) cancel(url);
    },
  };
}
