import { COLOR_CHECKER_PRESETS } from "./theme-color";

/** Reference signals for the home scopes: one real scan line, read by every display. */

export const SCOPE_SIGNALS = ["bars75", "bars100", "hue", "checker"] as const;
export const VECTOR_STYLES = ["trace", "points", "zoom"] as const;
export const WAVE_STYLES = ["luma", "rgb", "ycbcr", "overlay"] as const;
export const PHOSPHORS = ["white", "green", "amber", "signal"] as const;
export type ScopeSignal = (typeof SCOPE_SIGNALS)[number];
export type VectorStyle = (typeof VECTOR_STYLES)[number];
export type WaveStyle = (typeof WAVE_STYLES)[number];
export type Phosphor = (typeof PHOSPHORS)[number];

export const SCOPE_SIGNAL_LABELS: Record<ScopeSignal, string> = { bars75: "75% 彩条", bars100: "100% 彩条", hue: "色相环", checker: "ColorChecker" };
export const VECTOR_STYLE_LABELS: Record<VectorStyle, string> = { trace: "标准", points: "点阵", zoom: "×2 放大" };
export const WAVE_STYLE_LABELS: Record<WaveStyle, string> = { luma: "亮度", rgb: "RGB 分量", ycbcr: "YCbCr 分量", overlay: "RGB 叠加" };

type Rgb = readonly [number, number, number];
export type ScopeSample = { rgb: Rgb; luma: number; cb: number; cr: number };
export type ScopeBar = ScopeSample & { label: string };

const BARS = [
  ["W", 1, 1, 1], ["YL", 1, 1, 0], ["CY", 0, 1, 1], ["G", 0, 1, 0],
  ["MG", 1, 0, 1], ["R", 1, 0, 0], ["B", 0, 0, 1], ["K", 0, 0, 0],
] as const;
// Share of each patch spent rising to the next one.
const PATCH_RISE = 0.08;
const SCAN_SAMPLES = 960;

export function rec709YCbCr(r: number, g: number, b: number) {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { luma, cb: (b - luma) / 1.8556, cr: (r - luma) / 1.5748 };
}

function sample(rgb: Rgb): ScopeSample {
  return { rgb, ...rec709YCbCr(...rgb) };
}

/** Colour bars at `level`, in signal order, left to right across the frame. */
export function colorBars(level: number): ScopeBar[] {
  return BARS.map(([label, r, g, b]) => ({ label, ...sample([r * level, g * level, b * level]) }));
}

const CHECKER: Rgb[] = COLOR_CHECKER_PRESETS.map(({ hex }) =>
  [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255) as unknown as Rgb);

function patchAt(patches: readonly Rgb[], position: number): Rgb {
  const scaled = Math.min(patches.length - 1e-9, position * patches.length);
  const index = Math.floor(scaled);
  const within = scaled - index;
  const current = patches[index];
  if (within < 1 - PATCH_RISE || index === patches.length - 1) return current;
  const rise = (within - (1 - PATCH_RISE)) / PATCH_RISE;
  return current.map((value, channel) => value + (patches[index + 1][channel] - value) * rise) as unknown as Rgb;
}

// Full saturation at full level, once around the hue circle.
function hueAt(position: number): Rgb {
  const scaled = position * 6;
  const rising = scaled - Math.floor(scaled);
  const sextant = Math.floor(scaled) % 6;
  return ([[1, rising, 0], [1 - rising, 1, 0], [0, 1, rising], [0, 1 - rising, 1], [rising, 0, 1], [1, 0, 1 - rising]] as const)[sextant];
}

function signalAt(signal: ScopeSignal, position: number): Rgb {
  if (signal === "hue") return hueAt(position);
  if (signal === "checker") return patchAt(CHECKER, position);
  return patchAt(colorBars(signal === "bars75" ? 0.75 : 1).map(bar => bar.rgb), position);
}

/** One line of `signal`, left to right, as a scope would sample it. */
export function scanLine(signal: ScopeSignal, samples = SCAN_SAMPLES): ScopeSample[] {
  return Array.from({ length: samples }, (_, index) => sample(signalAt(signal, index / samples)));
}
