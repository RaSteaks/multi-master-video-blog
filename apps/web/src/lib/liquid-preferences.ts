import { hsvToRgb, type HsvColor } from "./theme-color";

export const LIQUID_STORAGE_KEY = "mm-liquid-background-v1";
export const LIQUID_PREFERENCES_EVENT = "liquid-preferences-change";
export type LiquidColor = { kind: "gray" } | { kind: "custom"; hsv: HsvColor };
export type LiquidPreferences = {
  version: 1;
  speed: number;
  color: LiquidColor;
  slots: (LiquidColor | null)[];
};
export type LiquidRgb = readonly [number, number, number];
export type LiquidPalette = readonly [LiquidRgb, LiquidRgb, LiquidRgb];

/** Self-contained so the same validation and palette run before hydration. */
export function resolveLiquidPreferences(
  raw: string | null,
  convert = hsvToRgb,
) {
  function color(value: unknown): LiquidColor | null {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (item.kind === "gray") return { kind: "gray" };
    if (item.kind !== "custom" || !item.hsv || typeof item.hsv !== "object")
      return null;
    const hsv = item.hsv as HsvColor;
    if (![hsv.h, hsv.s, hsv.v].every(Number.isFinite)) return null;
    return {
      kind: "custom",
      hsv: {
        h: Math.min(359, Math.max(0, Math.round(hsv.h))),
        s: Math.min(100, Math.max(0, Math.round(hsv.s))),
        v: Math.min(100, Math.max(0, Math.round(hsv.v))),
      },
    };
  }
  let input: Partial<LiquidPreferences> = {};
  try {
    const parsed = JSON.parse(raw || "null");
    if (parsed?.version === 1) input = parsed;
  } catch {
    /* Invalid preferences use the original gray palette. */
  }
  const settings: LiquidPreferences = {
    version: 1,
    speed:
      typeof input.speed === "number" && Number.isFinite(input.speed)
        ? Math.round(Math.min(3, Math.max(0, input.speed)) * 10) / 10
        : 1,
    color: color(input.color) || { kind: "gray" },
    slots: Array.from({ length: 5 }, (_, i) =>
      color(Array.isArray(input.slots) ? input.slots[i] : null),
    ),
  };
  let swatchHex = "#121518";
  let blobs = ["130 134 138", "108 112 116", "118 122 126"];
  if (settings.color.kind === "custom") {
    const rgb = convert(settings.color.hsv);
    const channels = [rgb.r, rgb.g, rgb.b];
    swatchHex =
      `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
    blobs = [0.35, 0.3, 0.32].map((mix) =>
      channels.map((c) => Math.round(c + (255 - c) * mix)).join(" "),
    );
  }
  const divisor = settings.speed || 1;
  const css: Record<string, string> = {
    // The surround stays dark; only the flowing blobs use the selected color.
    "--liquid-base": "#121518",
    "--liquid-blob-1": blobs[0],
    "--liquid-blob-2": blobs[1],
    "--liquid-blob-3": blobs[2],
    "--liquid-duration-1": `${20 / divisor}s`,
    "--liquid-duration-2": `${23 / divisor}s`,
    "--liquid-duration-3": `${22 / divisor}s`,
    "--liquid-play-state": settings.speed === 0 ? "paused" : "running",
  };
  return { settings, css, swatchHex };
}

export function defaultLiquidPreferences(): LiquidPreferences {
  return resolveLiquidPreferences(null).settings;
}

function parseRgbChannels(
  value: string | undefined,
  fallback: LiquidRgb,
): LiquidRgb {
  const channels = value
    ?.trim()
    .split(/\s+/)
    .map(Number);
  if (!channels || channels.length !== 3 || !channels.every(Number.isFinite))
    return fallback;
  return [
    Math.min(255, Math.max(0, channels[0])) / 255,
    Math.min(255, Math.max(0, channels[1])) / 255,
    Math.min(255, Math.max(0, channels[2])) / 255,
  ];
}

/** Converts the existing CSS-variable palette into uniforms for WebGL. */
export function liquidPaletteFromSettings(
  settings: LiquidPreferences,
): LiquidPalette {
  const { css } = resolveLiquidPreferences(JSON.stringify(settings));
  return [
    parseRgbChannels(css["--liquid-blob-1"], [130 / 255, 134 / 255, 138 / 255]),
    parseRgbChannels(css["--liquid-blob-2"], [108 / 255, 112 / 255, 116 / 255]),
    parseRgbChannels(css["--liquid-blob-3"], [118 / 255, 122 / 255, 126 / 255]),
  ];
}

export function applyLiquidPreferences(settings: LiquidPreferences) {
  const resolved = resolveLiquidPreferences(JSON.stringify(settings));
  const { css } = resolved;
  for (const [key, value] of Object.entries(css))
    document.documentElement.style.setProperty(key, value);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<LiquidPreferences>(LIQUID_PREFERENCES_EVENT, {
        detail: resolved.settings,
      }),
    );
  }
}

export function saveLiquidSlot(
  settings: LiquidPreferences,
  index: number,
  color: LiquidColor | null = settings.color,
): LiquidPreferences {
  if (!Number.isInteger(index) || index < 0 || index >= 5) return settings;
  return resolveLiquidPreferences(
    JSON.stringify({
      ...settings,
      slots: settings.slots.map((slot, i) => (i === index ? color : slot)),
    }),
  ).settings;
}

export function resetLiquidPreferences(
  settings: LiquidPreferences,
): LiquidPreferences {
  return { ...defaultLiquidPreferences(), slots: settings.slots };
}

function bootstrapLiquid(
  resolve: typeof resolveLiquidPreferences,
  convert: typeof hsvToRgb,
  key: string,
) {
  try {
    const { css } = resolve(localStorage.getItem(key), convert);
    for (const [name, value] of Object.entries(css))
      document.documentElement.style.setProperty(name, value);
  } catch {
    /* CSS provides the default palette when storage is unavailable. */
  }
}

export const LIQUID_BOOTSTRAP_SCRIPT = `(${bootstrapLiquid.toString()})(${resolveLiquidPreferences.toString()},${hsvToRgb.toString()},${JSON.stringify(LIQUID_STORAGE_KEY)});`;
