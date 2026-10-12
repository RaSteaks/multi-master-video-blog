export type Vector3Tuple = [number, number, number];

export type GaussianSplatConfig = {
  src: string;
  title: string;
  poster?: string;
  height: number;
  background: string;
  cameraPosition: Vector3Tuple;
  target: Vector3Tuple;
  position: Vector3Tuple;
  rotation: Vector3Tuple;
  scale: Vector3Tuple;
};

export type GaussianSplatParseResult =
  | { ok: true; config: GaussianSplatConfig }
  | { ok: false; error: string };

const DEFAULT_CONFIG: Omit<GaussianSplatConfig, "src"> = {
  title: "Interactive 3DGS scene",
  height: 620,
  background: "#050708",
  cameraPosition: [0, 0, 2.5],
  target: [0, 0, 0],
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

const SUPPORTED_SOURCE_SUFFIXES = [
  ".ply",
  ".compressed.ply",
  ".sog",
  "meta.json",
  "lod-meta.json",
];

export function parseGaussianSplatConfig(source: string): GaussianSplatParseResult {
  let value: unknown;

  try {
    value = JSON.parse(source.trim());
  } catch {
    return {
      ok: false,
      error: "The 3dgs block must contain valid JSON.",
    };
  }

  if (!isRecord(value)) {
    return {
      ok: false,
      error: "The 3dgs configuration must be a JSON object.",
    };
  }

  const src = readUrl(value.src);
  if (!src) {
    return {
      ok: false,
      error: 'A safe "src" URL is required.',
    };
  }

  if (!isSupportedSplatSource(src)) {
    return {
      ok: false,
      error:
        'The "src" URL must point to a .sog, .ply, .compressed.ply, .meta.json, or .lod-meta.json file.',
    };
  }

  const poster = value.poster === undefined ? undefined : readUrl(value.poster);
  if (value.poster !== undefined && !poster) {
    return {
      ok: false,
      error: 'The optional "poster" value must be a safe URL.',
    };
  }

  const background =
    typeof value.background === "string" && isHexColor(value.background)
      ? value.background
      : DEFAULT_CONFIG.background;

  const scale = readVector(value.scale, DEFAULT_CONFIG.scale);
  if (scale.some((part) => part === 0)) {
    return {
      ok: false,
      error: 'Every value in "scale" must be non-zero.',
    };
  }

  return {
    ok: true,
    config: {
      src,
      title: readTitle(value.title),
      ...(poster ? { poster } : {}),
      height: readHeight(value.height),
      background,
      cameraPosition: readVector(value.cameraPosition, DEFAULT_CONFIG.cameraPosition),
      target: readVector(value.target, DEFAULT_CONFIG.target),
      position: readVector(value.position, DEFAULT_CONFIG.position),
      rotation: readVector(value.rotation, DEFAULT_CONFIG.rotation),
      scale,
    },
  };
}

function readTitle(value: unknown) {
  if (typeof value !== "string") return DEFAULT_CONFIG.title;
  const title = value.trim();
  return title ? title.slice(0, 120) : DEFAULT_CONFIG.title;
}

function readHeight(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONFIG.height;
  }

  return Math.round(Math.min(820, Math.max(360, value)));
}

function readVector(value: unknown, fallback: Vector3Tuple): Vector3Tuple {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(
      (part) =>
        typeof part !== "number" ||
        !Number.isFinite(part) ||
        Math.abs(part) > 10_000,
    )
  ) {
    return [...fallback];
  }

  return [value[0], value[1], value[2]];
}

function readUrl(value: unknown) {
  if (typeof value !== "string") return null;

  const url = value.trim();
  if (!url || url.startsWith("//")) return null;

  if (url.startsWith("/")) {
    return url;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function isSupportedSplatSource(value: string) {
  try {
    const pathname = new URL(value, "https://local.invalid").pathname.toLowerCase();
    return SUPPORTED_SOURCE_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
  } catch {
    return false;
  }
}

function isHexColor(value: string) {
  return /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
