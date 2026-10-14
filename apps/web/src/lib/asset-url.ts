import managedAssetPresets from "../../../../config/directus-asset-presets.json";

// Client-safe asset helpers: pure URL/srcset logic with no Directus credentials
// or server fetch code, so client components can import it without pulling in
// lib/directus.ts.

export type DirectusFileId = string | null;
export type AssetPreset =
  | "album-cover"
  | "album-thumb"
  | "album-thumb-sm"
  | "content-card"
  | "content-hero"
  | "site-background"
  | "site-background-thumb";

export type ImageDimensions = { width: number; height: number };

// Named assets and their actual transformed dimensions come from the CMS setup contract.
const ASSET_PRESETS = new Set(managedAssetPresets.map((preset) => preset.key));

export function assetUrl(
  fileId: DirectusFileId,
  preset?: AssetPreset,
) {
  if (!fileId) return null;
  if (preset && !ASSET_PRESETS.has(preset)) {
    throw new Error(`Unsupported asset preset: ${preset}`);
  }
  const suffix = preset ? `?key=${encodeURIComponent(preset)}` : "";
  return `/api/assets/${fileId}${suffix}`;
}

const ALBUM_THUMB_PRESETS = managedAssetPresets.filter(
  (preset) => preset.key === "album-thumb-sm" || preset.key === "album-thumb",
);

function scaledThumbWidth(
  preset: { width: number; height: number },
  { width, height }: ImageDimensions,
) {
  // Match inside-fit resizing without enlarging a source smaller than the preset.
  return Math.max(
    1,
    Math.round(width * Math.min(1, preset.width / width, preset.height / height)),
  );
}

/** Width-descriptor srcset for album tiles; null when the file size is unknown. */
export function albumThumbSrcSet(
  fileId: DirectusFileId,
  dimensions: ImageDimensions | null | undefined,
) {
  if (
    !fileId ||
    !dimensions ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    return null;
  }
  const candidates = ALBUM_THUMB_PRESETS.map((preset) => ({
    url: assetUrl(fileId, preset.key as AssetPreset),
    width: scaledThumbWidth(preset, dimensions),
  }));
  // A file smaller than the small preset yields identical widths; keep one candidate per width.
  return candidates
    .filter((item, index) =>
      candidates.findIndex((other) => other.width === item.width) === index,
    )
    .map((item) => `${item.url} ${item.width}w`)
    .join(", ");
}
