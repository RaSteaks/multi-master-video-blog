/** Geometry for the chromaticity diagrams: loci, gamut triangles, MacAdam ellipses, hue lines. */

import { displayRgb, xyToUvPrime, xyToXyz, xyzToXy, type Vector } from "./color-math";
import { MACADAM_1942 } from "./color-science-data";
import { GAMUTS, cielabToXyz, gamutPrimaries, oklabToXyz, type GamutId } from "./color-volume";
import { daylightXy, insideLocus, isotherm, planckianXy, spectralLocus } from "./spectral";

export const CHROMATICITY_VIEWS = ["gamuts", "macadam", "hue"] as const;
export type ChromaticityView = (typeof CHROMATICITY_VIEWS)[number];
export const CHROMATICITY_LABELS: Record<ChromaticityView, string> = {
  gamuts: "CIE 1931 xy · 色域与普朗克轨迹",
  macadam: "麦克亚当椭圆 ×10 · xy ↔ u′v′",
  hue: "等色相线 · CIELAB 与 Oklab",
};

export type Point = readonly [number, number];

/** Square plotting frames, so an ellipse keeps its true shape in each. */
export const XY_FRAME = { left: -0.05, bottom: -0.02, side: 0.9 };
export const UV_FRAME = { left: -0.02, bottom: -0.02, side: 0.66 };

export function inFrame([x, y]: Point, frame: typeof XY_FRAME): Point {
  return [(x - frame.left) / frame.side, (y - frame.bottom) / frame.side];
}

const memo = <T,>(build: () => T) => {
  let value: T | undefined;
  return () => (value ??= build());
};

export const locus = memo(() => spectralLocus().filter(({ wavelength }) => wavelength <= 700));

/** Planckian locus from 1000 K to 25000 K, evenly in mired. */
export const planckianLocus = memo(() => Array.from({ length: 60 }, (_, index) => {
  const mired = 1000 - index * (1000 - 40) / 59;
  return planckianXy(1e6 / mired);
}));

export const ISOTHERM_KELVIN = [2000, 2856, 4000, 5000, 6500, 10000] as const;
export const isotherms = memo(() => ISOTHERM_KELVIN.map(kelvin => ({ kelvin, ends: isotherm(kelvin) })));

export const daylightLocus = memo(() => Array.from({ length: 30 }, (_, index) => daylightXy(4000 + index * (25000 - 4000) / 29)));

export const gamutTriangles = memo(() => GAMUTS.map(gamut => ({ gamut, corners: gamutPrimaries(gamut) as readonly Point[] })));

const ELLIPSE_POINTS = 48;
const MACADAM_MAGNIFY = 10;

/** MacAdam's 25 ellipses at ten times size, traced in xy; each point carries over to u′v′. */
export const macadamEllipses = memo(() => Array.from({ length: MACADAM_1942.length / 5 }, (_, index) => {
  const [x0, y0, a, b, degrees] = MACADAM_1942.slice(index * 5, index * 5 + 5);
  const theta = degrees * Math.PI / 180;
  const xy = Array.from({ length: ELLIPSE_POINTS + 1 }, (_, step): Point => {
    const s = step / ELLIPSE_POINTS * Math.PI * 2;
    const along = a * 1e-3 * MACADAM_MAGNIFY * Math.cos(s), across = b * 1e-3 * MACADAM_MAGNIFY * Math.sin(s);
    return [x0 + along * Math.cos(theta) - across * Math.sin(theta), y0 + along * Math.sin(theta) + across * Math.cos(theta)];
  });
  return { center: [x0, y0] as Point, xy, uv: xy.map(([x, y]) => xyToUvPrime(x, y)), color: displayRgb(xyToXyz(x0, y0, 0.6)) };
}));

export const HUE_LINE_DEGREES = Array.from({ length: 12 }, (_, index) => index * 30);
// Both models at the lightness of Y = 0.184 (L* = 50): constant hue, chroma growing to the locus.
const HUE_LINE_Y = 0.1842;

function hueLine(toXyz: (chroma: number, hue: number) => Vector, step: number, hue: number) {
  const points: Point[] = [];
  for (let chroma = 0; chroma < 600 * step; chroma += step) {
    const xyz = toXyz(chroma, hue);
    if (xyz.some(value => value < 0)) break;
    const xy = xyzToXy(xyz);
    if (chroma > 0 && !insideLocus(...xy)) break;
    points.push(xy);
  }
  return points;
}

export const hueLines = memo(() => {
  const labLightness = 116 * Math.cbrt(HUE_LINE_Y) - 16, okLightness = Math.cbrt(HUE_LINE_Y);
  return HUE_LINE_DEGREES.map(degrees => {
    const hue = degrees * Math.PI / 180;
    const lab = hueLine((chroma, h) => cielabToXyz([labLightness, chroma * Math.cos(h), chroma * Math.sin(h)]), 1, hue);
    const ok = hueLine((chroma, h) => oklabToXyz([okLightness, chroma * Math.cos(h), chroma * Math.sin(h)]), 0.0025, hue);
    const tip = lab[Math.floor(lab.length * 0.6)] ?? lab[0];
    return { degrees, lab, ok, color: displayRgb(xyToXyz(tip[0], tip[1], 0.5)) };
  });
});

export const whitePoints: { label: string; xy: Point; gamuts: readonly GamutId[] }[] = [
  { label: "D65", xy: [0.3127, 0.329], gamuts: ["rec709", "p3", "rec2020", "dwg", "awg4", "sgamut3"] },
  { label: "D60", xy: [0.32168, 0.33767], gamuts: ["ap0", "ap1"] },
];
