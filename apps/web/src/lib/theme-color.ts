export const THEME_STORAGE_KEY = "mm-theme-color-v1";
export const DEFAULT_ACCENT_HEX = "#7A7A7A";
export const ACCENT_SURFACE_HEX = "#252C34";
export const MIN_TEXT_CONTRAST = 4.5;

export type HsvColor = {
  h: number;
  s: number;
  v: number;
};

export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export type ColorCheckerPreset = {
  id: `cc${string}`;
  number: number;
  name: string;
  hex: `#${string}`;
};

export const COLOR_CHECKER_PRESETS = [
  { id: "cc01", number: 1, name: "深肤", hex: "#735244" },
  { id: "cc02", number: 2, name: "浅肤", hex: "#C29682" },
  { id: "cc03", number: 3, name: "蓝天", hex: "#627A9D" },
  { id: "cc04", number: 4, name: "植被", hex: "#576C43" },
  { id: "cc05", number: 5, name: "蓝花", hex: "#8580B1" },
  { id: "cc06", number: 6, name: "蓝绿色", hex: "#67BDAA" },
  { id: "cc07", number: 7, name: "橙色", hex: "#D67E2C" },
  { id: "cc08", number: 8, name: "紫蓝", hex: "#505BA6" },
  { id: "cc09", number: 9, name: "中红", hex: "#C15A63" },
  { id: "cc10", number: 10, name: "紫色", hex: "#5E3C6C" },
  { id: "cc11", number: 11, name: "黄绿", hex: "#9DBC40" },
  { id: "cc12", number: 12, name: "橙黄", hex: "#E0A32E" },
  { id: "cc13", number: 13, name: "蓝色", hex: "#383D96" },
  { id: "cc14", number: 14, name: "绿色", hex: "#469449" },
  { id: "cc15", number: 15, name: "红色", hex: "#AF363C" },
  { id: "cc16", number: 16, name: "黄色", hex: "#E7C71F" },
  { id: "cc17", number: 17, name: "品红", hex: "#BB5695" },
  { id: "cc18", number: 18, name: "青色", hex: "#0885A1" },
  { id: "cc19", number: 19, name: "白色", hex: "#F3F3F3" },
  { id: "cc20", number: 20, name: "Neutral 8", hex: "#C8C8C8" },
  { id: "cc21", number: 21, name: "Neutral 6.5", hex: "#A0A0A0" },
  { id: "cc22", number: 22, name: "Neutral 5", hex: "#7A7A7A" },
  { id: "cc23", number: 23, name: "Neutral 3.5", hex: "#555555" },
  { id: "cc24", number: 24, name: "黑色", hex: "#343434" },
] as const satisfies readonly ColorCheckerPreset[];

export type ColorCheckerPresetId =
  (typeof COLOR_CHECKER_PRESETS)[number]["id"];

export type ThemeSelection =
  | {
      kind: "preset";
      presetId: ColorCheckerPresetId;
    }
  | {
      kind: "custom";
      hsv: HsvColor;
    };

export type ResolvedThemeColor = {
  base: string;
  readable: string;
  onAccent: string;
  rgb: RgbColor;
  contrast: number;
  adjusted: boolean;
};

export type StoredThemeColor = {
  version: 1;
  kind: ThemeSelection["kind"];
  presetId?: ColorCheckerPresetId;
  hsv?: HsvColor;
  base: string;
  readable: string;
  onAccent: string;
};

const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/;
const presetMap = new Map(
  COLOR_CHECKER_PRESETS.map((preset) => [preset.id, preset])
);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toUpperCase();
  return HEX_COLOR_PATTERN.test(hex) ? hex : null;
}

export function normalizeHsv(value: HsvColor): HsvColor {
  return {
    h: clamp(Math.round(Number.isFinite(value.h) ? value.h : 0), 0, 359),
    s: clamp(Math.round(Number.isFinite(value.s) ? value.s : 0), 0, 100),
    v: clamp(Math.round(Number.isFinite(value.v) ? value.v : 0), 0, 100),
  };
}

function isStoredHsv(value: unknown): value is HsvColor {
  if (!value || typeof value !== "object") return false;
  const hsv = value as Record<string, unknown>;
  return (
    Number.isInteger(hsv.h) &&
    Number.isInteger(hsv.s) &&
    Number.isInteger(hsv.v) &&
    Number(hsv.h) >= 0 &&
    Number(hsv.h) <= 359 &&
    Number(hsv.s) >= 0 &&
    Number(hsv.s) <= 100 &&
    Number(hsv.v) >= 0 &&
    Number(hsv.v) <= 100
  );
}

export function hexToRgb(value: string): RgbColor {
  const hex = normalizeHex(value);
  if (!hex) {
    throw new Error(`Invalid sRGB hex color: ${value}`);
  }

  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: RgbColor): string {
  const channel = (value: number) =>
    clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}

export function rgbToHsv({ r, g, b }: RgbColor): HsvColor {
  const red = clamp(r, 0, 255) / 255;
  const green = clamp(g, 0, 255) / 255;
  const blue = clamp(b, 0, 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === red) {
      hue = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
      hue = 60 * ((blue - red) / delta + 2);
    } else {
      hue = 60 * ((red - green) / delta + 4);
    }
  }

  if (hue < 0) hue += 360;

  return {
    h: hue,
    s: max === 0 ? 0 : (delta / max) * 100,
    v: max * 100,
  };
}

export function hexToHsv(value: string): HsvColor {
  return rgbToHsv(hexToRgb(value));
}

export function hsvToRgb(value: HsvColor): RgbColor {
  const hue = clamp(value.h, 0, 359.999999);
  const saturation = clamp(value.s, 0, 100) / 100;
  const brightness = clamp(value.v, 0, 100) / 100;
  const chroma = brightness * saturation;
  const segment = hue / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const offset = brightness - chroma;

  let red = 0;
  let green = 0;
  let blue = 0;

  if (segment < 1) {
    red = chroma;
    green = x;
  } else if (segment < 2) {
    red = x;
    green = chroma;
  } else if (segment < 3) {
    green = chroma;
    blue = x;
  } else if (segment < 4) {
    green = x;
    blue = chroma;
  } else if (segment < 5) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }

  return {
    r: Math.round((red + offset) * 255),
    g: Math.round((green + offset) * 255),
    b: Math.round((blue + offset) * 255),
  };
}

export function hsvToHex(value: HsvColor): string {
  return rgbToHex(hsvToRgb(value));
}

function srgbChannelToLinear(channel: number) {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function linearChannelToRec709(channel: number) {
  const value = clamp(channel, 0, 1);
  return value < 0.018
    ? 4.5 * value
    : 1.099 * value ** 0.45 - 0.099;
}

/**
 * Converts full-range sRGB code values to full-range Rec.709 OETF code values
 * while preserving the same linear-light RGB triplet.
 */
export function srgbHexToRec709Hex(value: string) {
  const { r, g, b } = hexToRgb(value);
  return rgbToHex({
    r: linearChannelToRec709(srgbChannelToLinear(r)) * 255,
    g: linearChannelToRec709(srgbChannelToLinear(g)) * 255,
    b: linearChannelToRec709(srgbChannelToLinear(b)) * 255,
  });
}

export function relativeLuminance(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

export function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

export function deriveReadableColor(
  baseColor: string,
  surfaceColor = ACCENT_SURFACE_HEX
) {
  const base = normalizeHex(baseColor) ?? DEFAULT_ACCENT_HEX;
  const initialContrast = contrastRatio(base, surfaceColor);
  if (initialContrast >= MIN_TEXT_CONTRAST) {
    return {
      color: base,
      contrast: initialContrast,
      adjusted: false,
    };
  }

  const hsv = hexToHsv(base);
  let low = 0;
  let high = 1;
  let readable = "#FFFFFF";

  for (let iteration = 0; iteration < 32; iteration += 1) {
    const amount = (low + high) / 2;
    const candidate = hsvToHex({
      h: hsv.h,
      s: hsv.s * (1 - amount),
      v: hsv.v + (100 - hsv.v) * amount,
    });

    if (contrastRatio(candidate, surfaceColor) >= MIN_TEXT_CONTRAST) {
      high = amount;
      readable = candidate;
    } else {
      low = amount;
    }
  }

  // Account for 8-bit rounding at the binary-search boundary.
  if (contrastRatio(readable, surfaceColor) < MIN_TEXT_CONTRAST) {
    readable = hsvToHex({
      h: hsv.h,
      s: hsv.s * (1 - high),
      v: hsv.v + (100 - hsv.v) * high,
    });
  }

  return {
    color: readable,
    contrast: contrastRatio(readable, surfaceColor),
    adjusted: true,
  };
}

export function chooseOnAccent(baseColor: string) {
  const base = normalizeHex(baseColor) ?? DEFAULT_ACCENT_HEX;
  const dark = "#0C0E10";
  const light = "#F3F3F3";
  return contrastRatio(dark, base) >= contrastRatio(light, base)
    ? dark
    : light;
}

export function resolveThemeColor(value: unknown): ResolvedThemeColor {
  const base = normalizeHex(value) ?? DEFAULT_ACCENT_HEX;
  const readable = deriveReadableColor(base);
  return {
    base,
    readable: readable.color,
    onAccent: chooseOnAccent(base),
    rgb: hexToRgb(base),
    contrast: readable.contrast,
    adjusted: readable.adjusted,
  };
}

export function createStoredTheme(
  selection: ThemeSelection
): StoredThemeColor {
  if (selection.kind === "preset") {
    const preset = presetMap.get(selection.presetId);
    if (!preset) {
      throw new Error(`Unknown ColorChecker preset: ${selection.presetId}`);
    }
    const resolved = resolveThemeColor(preset.hex);
    return {
      version: 1,
      kind: "preset",
      presetId: preset.id,
      base: resolved.base,
      readable: resolved.readable,
      onAccent: resolved.onAccent,
    };
  }

  const hsv = normalizeHsv(selection.hsv);
  const resolved = resolveThemeColor(hsvToHex(hsv));
  return {
    version: 1,
    kind: "custom",
    hsv,
    base: resolved.base,
    readable: resolved.readable,
    onAccent: resolved.onAccent,
  };
}

export function parseStoredTheme(value: string | null): StoredThemeColor | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || parsed.version !== 1) return null;

    if (parsed.kind === "preset" && typeof parsed.presetId === "string") {
      if (!presetMap.has(parsed.presetId as ColorCheckerPresetId)) return null;
      return createStoredTheme({
        kind: "preset",
        presetId: parsed.presetId as ColorCheckerPresetId,
      });
    }

    if (parsed.kind === "custom" && isStoredHsv(parsed.hsv)) {
      return createStoredTheme({ kind: "custom", hsv: parsed.hsv });
    }
  } catch {
    return null;
  }

  return null;
}

export function storedThemeToResolved(
  stored: StoredThemeColor
): ResolvedThemeColor {
  return resolveThemeColor(stored.base);
}

export function rgbChannels({ r, g, b }: RgbColor) {
  return `${r} ${g} ${b}`;
}

export const THEME_BOOTSTRAP_SCRIPT = `(() => {
  try {
    const raw = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (!raw) return;
    const value = JSON.parse(raw);
    const hex = /^#[0-9A-F]{6}$/;
    const preset = value && value.kind === "preset" && /^cc(?:0[1-9]|1[0-9]|2[0-4])$/.test(value.presetId);
    const hsv = value && value.kind === "custom" && value.hsv &&
      Number.isInteger(value.hsv.h) && value.hsv.h >= 0 && value.hsv.h <= 359 &&
      Number.isInteger(value.hsv.s) && value.hsv.s >= 0 && value.hsv.s <= 100 &&
      Number.isInteger(value.hsv.v) && value.hsv.v >= 0 && value.hsv.v <= 100;
    if (value.version !== 1 || (!preset && !hsv) ||
        !hex.test(value.base) || !hex.test(value.readable) || !hex.test(value.onAccent)) return;
    const root = document.documentElement;
    const base = value.base;
    const channels = [
      parseInt(base.slice(1, 3), 16),
      parseInt(base.slice(3, 5), 16),
      parseInt(base.slice(5, 7), 16)
    ].join(" ");
    root.style.setProperty("--user-accent-base", base);
    root.style.setProperty("--user-accent-readable", value.readable);
    root.style.setProperty("--user-on-accent", value.onAccent);
    root.style.setProperty("--user-accent-rgb", channels);
    root.dataset.themeColor = "local";
  } catch {}
})();`;
