/** Numbers behind the spectrum diagrams: metamers, a camera against the observer, TM-30. */

import { apply, brightestRgb, displayRgb, invert, lerp, multiply, type Matrix, type Vector } from "./color-math";
import {
  CIE_1931_X,
  CIE_1931_Y,
  CIE_1931_Z,
  D65_SPD,
  METAMER_BASE,
  METAMER_PAIR,
  NIKON_5100_B,
  NIKON_5100_G,
  NIKON_5100_R,
  TM30_SOURCES,
} from "./color-science-data";
import { blackbody, spectrumToXyz } from "./spectral";

export const SPECTRUM_VIEWS = ["cmf", "rgbcmf", "blackbody", "metamer", "tm30", "camera"] as const;
export type SpectrumView = (typeof SPECTRUM_VIEWS)[number];
export const SPECTRUM_LABELS: Record<SpectrumView, string> = {
  cmf: "CIE 1931 2° 配色函数",
  rgbcmf: "Wright & Guild 1931 RGB 配色函数",
  blackbody: "黑体辐射 · 2000–10000 K",
  metamer: "同色异谱 · D65 ↔ A",
  tm30: "ANSI/IES TM-30 色矢量图",
  camera: "Nikon D5100 光谱灵敏度 · Luther 条件",
};

const ILLUMINANT_A = blackbody(2856);
// D65 is tabulated as 100 at 560 nm, the blackbody as 1; bring them to one scale before blending.
const D65 = D65_SPD.map(value => value / 100);

const BRADFORD: Matrix = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

/** Bradford adaptation from `white` to D65, so a swatch is seen as an adapted eye sees it. */
function adaptToD65(xyz: Vector, white: Vector): Vector {
  // A perfect reflector has unit reflectance; the illuminant contributes D65 only once.
  const target = apply(BRADFORD, spectrumToXyz(D65.map(() => 1), D65));
  const source = apply(BRADFORD, white);
  const gain: Matrix = [[target[0] / source[0], 0, 0], [0, target[1] / source[1], 0], [0, 0, target[2] / source[2]]];
  return apply(multiply(invert(BRADFORD), multiply(gain, BRADFORD)), xyz);
}

function lab(xyz: Vector, white: Vector): Vector {
  const f = (ratio: number) => ratio > 216 / 24389 ? Math.cbrt(ratio) : (ratio * 24389 / 27 + 16) / 116;
  const [x, y, z] = xyz.map((value, index) => f(value / white[index]));
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** The metameric pair lit by a blend `toA` of the way from D65 to illuminant A. */
export function metamerScene(toA: number) {
  const illuminant = D65.map((value, index) => lerp(value, ILLUMINANT_A[index], toA));
  const white = spectrumToXyz(illuminant.map(() => 1), illuminant);
  const pair = [METAMER_BASE, METAMER_PAIR].map(reflectance => spectrumToXyz(reflectance, illuminant));
  const [first, second] = pair.map(xyz => lab(xyz, white));
  return {
    illuminant,
    colors: pair.map(xyz => displayRgb(adaptToD65(xyz, white))),
    deltaE: Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]),
  };
}

/**
 * The camera's measured sensitivities (each channel peaking at 1) and the closest
 * mix of the observer's x̄ȳz̄ to each. A camera meeting the Luther condition matches exactly.
 */
export const cameraFit = (() => {
  const camera = [NIKON_5100_R, NIKON_5100_G, NIKON_5100_B].map(channel => {
    const peak = Math.max(...channel);
    return channel.map(value => value / peak);
  });
  const observer = [CIE_1931_X, CIE_1931_Y, CIE_1931_Z];
  const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const gram = invert(observer.map(a => observer.map(b => dot(a, b))) as unknown as Matrix);
  const fitted = camera.map(channel => {
    const weights = apply(gram, observer.map(row => dot(row, channel)) as unknown as Vector);
    return channel.map((_, index) => weights[0] * CIE_1931_X[index] + weights[1] * CIE_1931_Y[index] + weights[2] * CIE_1931_Z[index]);
  });
  const residual = camera.map((channel, index) =>
    Math.sqrt(channel.reduce((sum, value, at) => sum + (value - fitted[index][at]) ** 2, 0) / dot(channel, channel)));
  return { camera, fitted, residual };
})();

/** A source's vectors and scores share the same reference illuminant. */
export function tm30Frame(index: number) {
  const source = TM30_SOURCES[index];
  return {
    ...source,
    test: source.reference.map((_, bin) => [source.test[bin * 2], source.test[bin * 2 + 1]] as const),
  };
}

/** A blackbody's chromaticity as a display colour, its brightest channel full. */
export function blackbodyColor(kelvin: number): Vector {
  return brightestRgb(spectrumToXyz(blackbody(kelvin)));
}
