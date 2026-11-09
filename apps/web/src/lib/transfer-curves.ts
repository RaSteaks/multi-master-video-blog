/** Transfer functions, tone curves and a film characteristic curve, for the curve diagram. */

import { clamp01, srgbEncode } from "./color-math";
import { agxLogEncode, agxSigmoid, rrtOdtFit } from "./color-transform";

export const CURVE_VIEWS = ["transfer", "tonemap", "film"] as const;
export type CurveView = (typeof CURVE_VIEWS)[number];
export const CURVE_LABELS: Record<CurveView, string> = {
  transfer: "传递函数 · 1.0 = 漫反射白",
  tonemap: "色调映射 · 中性灰 · sRGB 显示",
  film: "胶片特性曲线 · 示意",
};

/** The horizontal span of the transfer and tone plots, in stops about 18% grey. */
export const STOPS_RANGE = [-8, 8] as const;
export const MIDDLE_GREY = 0.18;

const pqConstants = { m1: 2610 / 16384, m2: 2523 / 32, c1: 3424 / 4096, c2: 2413 / 128, c3: 2392 / 128 };

/** SMPTE ST 2084 inverse EOTF, nits in, signal out. */
export function pqEncode(nits: number) {
  const { m1, m2, c1, c2, c3 } = pqConstants;
  const y = (Math.max(0, nits) / 10000) ** m1;
  return ((c1 + c2 * y) / (1 + c3 * y)) ** m2;
}

/** BT.2100 HLG OETF, scene light 0–1 in. */
export function hlgEncode(scene: number) {
  const a = 0.17883277, b = 1 - 4 * a, c = 0.5 - a * Math.log(4 * a);
  const e = clamp01(scene);
  return e <= 1 / 12 ? Math.sqrt(3 * e) : a * Math.log(12 * e - b) + c;
}

/** BT.709 OETF. */
export function rec709Encode(scene: number) {
  const e = clamp01(scene);
  return e < 0.018 ? 4.5 * e : 1.099 * e ** 0.45 - 0.099;
}

/** ARRI LogC4 (ALEXA 35). */
export function logC4Encode(linear: number) {
  const a = (2 ** 18 - 16) / 117.45, b = (1023 - 95) / 1023, c = 95 / 1023;
  const s = (7 * Math.LN2 * 2 ** (7 - 14 * c / b)) / (a * b);
  const t = (2 ** (14 * (-c / b) + 6) - 64) / a;
  return linear >= t ? (Math.log2(a * linear + 64) - 6) / 14 * b + c : (linear - t) / s;
}

/** Sony S-Log3, scene reflectance in (18% grey → 420/1023). */
export function sLog3Encode(linear: number) {
  return linear >= 0.01125
    ? (420 + Math.log10((linear + 0.01) / (0.18 + 0.01)) * 261.5) / 1023
    : (linear * (171.2102946929 - 95) / 0.01125 + 95) / 1023;
}

/** Blackmagic DaVinci Intermediate. */
export function davinciIntermediateEncode(linear: number) {
  const a = 0.0075, b = 7, c = 0.07329248, m = 10.44426855, cut = 0.00262409;
  return linear <= cut ? linear * m : c * (Math.log2(linear + a) + b);
}

// BT.2408: HDR reference white is 203 nits in PQ and 75% signal (scene 0.265) in HLG.
const PQ_WHITE_NITS = 203, HLG_WHITE_SCENE = 0.26496;

export type Curve = { label: string; encode: (sceneLinear: number) => number; color: readonly [number, number, number] };

/** Scene-linear with diffuse white at 1.0 in, code value 0–1 out. */
export const TRANSFER_CURVES: Curve[] = [
  { label: "sRGB", encode: value => srgbEncode(clamp01(value)), color: [0.86, 0.88, 0.9] },
  { label: "BT.709", encode: rec709Encode, color: [0.62, 0.66, 0.72] },
  { label: "Gamma 2.4", encode: value => clamp01(value) ** (1 / 2.4), color: [0.48, 0.52, 0.58] },
  { label: "PQ (203 nit 白)", encode: value => pqEncode(value * PQ_WHITE_NITS), color: [0.96, 0.62, 0.3] },
  { label: "HLG", encode: value => hlgEncode(value * HLG_WHITE_SCENE), color: [0.96, 0.84, 0.36] },
  { label: "ARRI LogC4", encode: logC4Encode, color: [0.44, 0.78, 0.96] },
  { label: "Sony S-Log3", encode: sLog3Encode, color: [0.62, 0.56, 0.98] },
  { label: "DaVinci Intermediate", encode: davinciIntermediateEncode, color: [0.42, 0.9, 0.62] },
];

// Hable's Uncharted 2 operator with his exposure bias and white point; past that white the display clips.
function hablePartial(x: number) {
  const a = 0.15, b = 0.5, c = 0.1, d = 0.2, e = 0.02, f = 0.3;
  return (x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f) - e / f;
}

/** Scene-linear in, display-linear out, for a neutral. */
export const TONE_CURVES: Curve[] = [
  { label: "直接裁切", encode: value => clamp01(value), color: [0.55, 0.58, 0.62] },
  { label: "Reinhard", encode: value => value / (1 + value), color: [0.96, 0.84, 0.36] },
  { label: "Hable（Uncharted 2）", encode: value => clamp01(hablePartial(2 * value) / hablePartial(11.2)), color: [0.96, 0.62, 0.3] },
  { label: "ACES（Hill 拟合）", encode: value => clamp01(rrtOdtFit(value)), color: [0.44, 0.78, 0.96] },
  { label: "AgX", encode: value => Math.max(0, agxSigmoid(agxLogEncode(value))) ** 2.2, color: [0.42, 0.9, 0.62] },
];

export const stopsToLinear = (stops: number) => MIDDLE_GREY * 2 ** stops;

/**
 * A schematic negative characteristic curve: base + fog, a toe, a straight line of
 * slope γ and a shoulder, density against log₁₀ exposure (0 = a grey card).
 * Not the data of any real stock.
 */
export const FILM = { baseFog: 0.15, gamma: 0.6, toe: -1.6, shoulder: 0.9, softness: 0.22, range: [-2.6, 1.8] as const };

export function filmDensity(logExposure: number) {
  const { baseFog, gamma, toe, shoulder, softness } = FILM;
  const soft = (u: number) => softness * Math.log1p(Math.exp(u / softness));
  return baseFog + gamma * (soft(logExposure - toe) - soft(logExposure - shoulder));
}
