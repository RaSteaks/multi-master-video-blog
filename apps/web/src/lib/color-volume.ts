/** Gamut solids for the home diagram: RGB cubes carried through real colour coordinates. */

import {
  D65_WHITE,
  REC709_TO_XYZ,
  XYZ_TO_REC709,
  apply,
  displayRgb,
  invert,
  lerp,
  lerpVector,
  mapVector,
  signedPow,
  srgbDecode,
  srgbEncode,
  type Matrix,
  type Vector,
} from "./color-math";
import { POINTER_XYZ_D65 } from "./color-science-data";
import { WAVELENGTHS, optimalColor } from "./spectral";

export type { Vector } from "./color-math";

export const GAMUTS = ["rec709", "p3", "rec2020", "ap0", "ap1", "dwg", "awg4", "sgamut3"] as const;
export const COLOR_MODELS = [
  "xyz", "xyy", "lms", "ycbcr", "hsv", "hsl", "cielab", "cieluv", "ipt", "oklab", "ictcp", "jzazbz", "cam16", "zcam",
] as const;
export const VOLUME_OVERLAYS = ["none", "optimal", "pointer", "gradient"] as const;
export type GamutId = (typeof GAMUTS)[number];
export type ColorModelId = (typeof COLOR_MODELS)[number];
export type VolumeOverlay = (typeof VOLUME_OVERLAYS)[number];

export const GAMUT_LABELS: Record<GamutId, string> = {
  rec709: "Rec.709", p3: "P3-D65", rec2020: "Rec.2020", ap0: "ACES AP0",
  ap1: "ACES AP1", dwg: "DaVinci WG", awg4: "ARRI WG4", sgamut3: "S-Gamut3",
};
export const COLOR_MODEL_LABELS: Record<ColorModelId, string> = {
  xyz: "CIE XYZ", xyy: "CIE xyY", lms: "LMS (HPE)", ycbcr: "Y′CbCr", hsv: "HSV", hsl: "HSL",
  cielab: "CIELAB", cieluv: "CIELUV", ipt: "IPT", oklab: "Oklab", ictcp: "ICtCp", jzazbz: "Jzazbz",
  cam16: "CAM16-UCS", zcam: "ZCAM",
};
export const VOLUME_OVERLAY_LABELS: Record<VolumeOverlay, string> = {
  none: "", optimal: "最优色边界（D65）", pointer: "Pointer 色域", gradient: "蓝→黄渐变路径",
};
/** Models read off Rec.709 R′G′B′, so wider gamuts show up as overshoot. */
export const REC709_MODELS: readonly ColorModelId[] = ["ycbcr", "hsv", "hsl"];

const RGB_TO_XYZ: Record<GamutId, Matrix> = {
  rec709: [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]],
  p3: [[0.4865709, 0.2656677, 0.1982173], [0.2289746, 0.6917385, 0.0792869], [0, 0.0451134, 1.0439444]],
  rec2020: [[0.636958, 0.1446169, 0.168881], [0.2627002, 0.6779981, 0.0593017], [0, 0.0280727, 1.0609851]],
  ap0: [[0.9525523959, 0, 0.0000936786], [0.3439664498, 0.7281660966, -0.0721325464], [0, 0, 1.0088251844]],
  // Normalised primary matrices from each vendor's published primaries (colour-science 0.4.4).
  ap1: [[0.6624541811, 0.1340042065, 0.156187687], [0.2722287168, 0.6740817658, 0.0536895174], [-0.0055746495, 0.0040607335, 1.0103391003]],
  dwg: [[0.7006223921, 0.1487748151, 0.1010587198], [0.2741185109, 0.8736318959, -0.1477504068], [-0.0989629129, -0.1378953251, 1.3259159887]],
  awg4: [[0.7048583204, 0.1297602952, 0.1158373115], [0.2545241764, 0.7814777327, -0.0360019091], [0, 0, 1.0890577508]],
  sgamut3: [[0.7064827132, 0.1288010498, 0.1151721641], [0.2709796708, 0.7866064112, -0.057586082], [-0.0096778454, 0.0046000375, 1.0941355587]],
};
// The ACES gamuts' white is D60. The appearance models below take D65, so it is adapted (Bradford) for them.
const D60_TO_D65: Matrix = [[0.987224, -0.0061132, 0.0159533], [-0.0075984, 1.0018615, 0.00533], [0.0030726, -0.005096, 1.0816806]];
const D60_GAMUTS: readonly GamutId[] = ["ap0", "ap1"];
const XYZ_TO_REC2020: Matrix = invert(RGB_TO_XYZ.rec2020);
const WHITE = D65_WHITE;
// BT.2408 reference white; ICtCp and Jzazbz are defined on absolute luminance.
const HDR_WHITE_NITS = 203;

/** XYZ of linear RGB in `gamut`, under D65 (the ACES gamuts adapted from D60). */
export function gamutToXyzD65(gamut: GamutId, linearRgb: Vector): Vector {
  const xyz = apply(RGB_TO_XYZ[gamut], linearRgb);
  return D60_GAMUTS.includes(gamut) ? apply(D60_TO_D65, xyz) : xyz;
}

/** Linear Rec.709 RGB of linear RGB in `gamut`, white to white. */
export function gamutToRec709(gamut: GamutId, linearRgb: Vector): Vector {
  return apply(XYZ_TO_REC709, gamutToXyzD65(gamut, linearRgb));
}

/** The xy chromaticity of each primary, red, green, blue. */
export function gamutPrimaries(gamut: GamutId) {
  return ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const).map(rgb => {
    const [x, y, z] = apply(RGB_TO_XYZ[gamut], rgb);
    return [x / (x + y + z), y / (x + y + z)] as const;
  });
}

function cielab(xyz: Vector): Vector {
  const [x, y, z] = xyz.map((value, index) => {
    const ratio = value / WHITE[index];
    return ratio > 216 / 24389 ? Math.cbrt(ratio) : (ratio * 24389 / 27 + 16) / 116;
  });
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function cielabToXyz([l, a, b]: Vector): Vector {
  const fy = (l + 16) / 116;
  const inverse = (f: number) => f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) * 27 / 24389;
  return [inverse(fy + a / 500) * WHITE[0], inverse(fy) * WHITE[1], inverse(fy - b / 200) * WHITE[2]];
}

function cieluv([x, y, z]: Vector): Vector {
  const sum = x + 15 * y + 3 * z;
  // L* scales u* and v*, so an imaginary primary's negative luminance would fling it
  // thousands of units out. It has no CIELUV lightness; it sits at black instead.
  if (sum === 0 || y <= 0) return [0, 0, 0];
  const whiteSum = WHITE[0] + 15 * WHITE[1] + 3 * WHITE[2];
  const ratio = y / WHITE[1];
  const l = ratio > 216 / 24389 ? 116 * Math.cbrt(ratio) - 16 : ratio * 24389 / 27;
  return [l, 13 * l * (4 * x / sum - 4 * WHITE[0] / whiteSum), 13 * l * (9 * y / sum - 9 * WHITE[1] / whiteSum)];
}

const OKLAB_LMS: Matrix = [[0.8189330101, 0.3618667424, -0.1288597137], [0.0329845436, 0.9293118715, 0.0361456387], [0.0482003018, 0.2643662691, 0.633851707]];
const OKLAB_LAB: Matrix = [[0.2104542553, 0.793617785, -0.0040720468], [1.9779984951, -2.428592205, 0.4505937099], [0.0259040371, 0.7827717662, -0.808675766]];
const OKLAB_LMS_INVERSE = invert(OKLAB_LMS), OKLAB_LAB_INVERSE = invert(OKLAB_LAB);

export function oklab(xyz: Vector): Vector {
  return apply(OKLAB_LAB, mapVector(apply(OKLAB_LMS, xyz), Math.cbrt));
}

export function oklabToXyz(lab: Vector): Vector {
  return apply(OKLAB_LMS_INVERSE, mapVector(apply(OKLAB_LAB_INVERSE, lab), value => value ** 3));
}

// Ebner & Fairchild (1998), D65.
function ipt(xyz: Vector): Vector {
  const lms = apply([[0.4002, 0.7075, -0.0807], [-0.228, 1.15, 0.0612], [0, 0, 0.9184]], xyz);
  return apply([[0.4, 0.4, 0.2], [4.455, -4.851, 0.396], [0.8056, 0.3572, -1.1628]], mapVector(lms, value => signedPow(value, 0.43)));
}

function pq(nits: number, m2 = 2523 / 32) {
  const m1 = 2610 / 16384, c1 = 3424 / 4096, c2 = 2413 / 128, c3 = 2392 / 128;
  const y = Math.pow(Math.max(0, nits) / 10000, m1);
  return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
}

function ictcp(xyz: Vector): Vector {
  const rgb = apply(XYZ_TO_REC2020, xyz);
  const lms = apply([[1688 / 4096, 2146 / 4096, 262 / 4096], [683 / 4096, 2951 / 4096, 462 / 4096], [99 / 4096, 309 / 4096, 3688 / 4096]], rgb);
  const [l, m, s] = lms.map(value => pq(value * HDR_WHITE_NITS));
  return apply([[0.5, 0.5, 0], [6610 / 4096, -13613 / 4096, 7003 / 4096], [17933 / 4096, -17390 / 4096, -543 / 4096]], [l, m, s]);
}

// Safdar et al. (2017), with the re-optimised PQ exponent; the 2021 variant feeds ZCAM.
const JZ_M2 = 1.7 * 2523 / 32;
const JZ_LMS: Matrix = [[0.41478972, 0.579999, 0.014648], [-0.20151, 1.120649, 0.0531008], [-0.0166008, 0.2648, 0.6684799]];
const JZ_AB: readonly [Vector, Vector] = [[3.524, -4.066708, 0.542708], [0.199076, 1.096799, -1.295875]];

function izazbz([x, y, z]: Vector, method: "2017" | "2021"): Vector {
  const shifted: Vector = [1.15 * x - 0.15 * z, 0.66 * y + 0.34 * x, z];
  const [l, m, s] = apply(JZ_LMS, shifted).map(value => pq(value, JZ_M2));
  const ab = JZ_AB.map(row => row[0] * l + row[1] * m + row[2] * s);
  const intensity = method === "2017" ? (l + m) / 2 : m - 3.7035226210190005e-11;
  return [intensity, ab[0], ab[1]];
}

function jzazbz(xyz: Vector): Vector {
  const [i, a, b] = izazbz(mapVector(xyz, value => value * HDR_WHITE_NITS), "2017");
  return [0.44 * i / (1 - 0.56 * i) - 1.6295499532821566e-11, a, b];
}

// Safdar et al. (2021): average surround, 20% background, 64 cd/m² adapting field, 100 cd/m² white, D65 discounted.
const ZCAM = (() => {
  const adapting = 64, surround = 0.69;
  const background = Math.sqrt(20 / 100);
  const luminance = 0.171 * Math.cbrt(adapting) * (1 - Math.exp(-48 / 9 * adapting));
  const exponent = 1.6 * surround / background ** 0.12;
  const brightnessScale = surround ** 2.2 * background ** 0.5 * luminance ** 0.2;
  const whiteIntensity = izazbz(mapVector(WHITE, value => value * 100), "2021")[0];
  const whiteBrightness = 2700 * whiteIntensity ** exponent * brightnessScale;
  return { background, luminance, exponent, brightnessScale, whiteIntensity, whiteBrightness };
})();

function zcam(xyz: Vector): Vector {
  const { background, luminance, exponent, brightnessScale, whiteIntensity, whiteBrightness } = ZCAM;
  const [i, a, b] = izazbz(mapVector(xyz, value => value * 100), "2021");
  const hue = Math.atan2(b, a);
  const eccentricity = 1.015 + Math.cos((89.038 * Math.PI / 180) + hue);
  const lightness = 100 * 2700 * signedPow(i, exponent) * brightnessScale / whiteBrightness;
  const colorfulness = 100 * (a * a + b * b) ** 0.37 * signedPow(eccentricity, 0.068) * luminance ** 0.2
    / (background ** 0.1 * whiteIntensity ** 0.78);
  return [lightness, colorfulness * Math.cos(hue), colorfulness * Math.sin(hue)];
}

// Average surround, 20% background, 64 cd/m² adapting field, illuminant fully discounted.
const CAM16 = (() => {
  const adapting = 64, background = 20, surround = 0.69;
  const toCone: Matrix = [[0.401288, 0.650173, -0.051461], [-0.250268, 1.204414, 0.045854], [-0.002079, 0.048952, 0.953127]];
  const k = 1 / (5 * adapting + 1);
  const luminance = 0.2 * k ** 4 * (5 * adapting) + 0.1 * (1 - k ** 4) ** 2 * Math.cbrt(5 * adapting);
  const n = background / 100;
  const z = 1.48 + Math.sqrt(n);
  const induction = 0.725 * (1 / n) ** 0.2;
  const whiteCone = apply(toCone, [WHITE[0] * 100, WHITE[1] * 100, WHITE[2] * 100]);
  const gain = whiteCone.map(value => 100 / value);
  const compress = (value: number) => {
    const scaled = Math.pow(luminance * Math.abs(value) / 100, 0.42);
    return Math.sign(value) * 400 * scaled / (27.13 + scaled) + 0.1;
  };
  const achromatic = ([r, g, b]: number[]) => (2 * r + g + 0.05 * b - 0.305) * induction;
  const whiteResponse = achromatic(whiteCone.map((value, index) => compress(value * gain[index])));
  return { toCone, luminance, n, z, induction, gain, compress, achromatic, surround, whiteResponse };
})();

function cam16ucs(xyz: Vector): Vector {
  const { toCone, luminance, n, z, induction, gain, compress, achromatic, surround, whiteResponse } = CAM16;
  const cone = apply(toCone, [xyz[0] * 100, xyz[1] * 100, xyz[2] * 100]);
  const [r, g, b] = cone.map((value, index) => compress(value * gain[index]));
  const a = r - 12 * g / 11 + b / 11;
  const yb = (r + g - 2 * b) / 9;
  const hue = Math.atan2(yb, a);
  const eccentricity = (Math.cos(hue + 2) + 3.8) / 4;
  const lightness = 100 * Math.pow(Math.max(0, achromatic([r, g, b]) / whiteResponse), surround * z);
  // AP0's imaginary primaries can drive this negative; its size is what matters here.
  const t = Math.abs(50000 / 13 * induction * eccentricity * Math.hypot(a, yb) / (r + g + 21 / 20 * b));
  const chroma = Math.pow(t, 0.9) * Math.sqrt(lightness / 100) * Math.pow(1.64 - 0.29 ** n, 0.73);
  const colorfulness = Math.log(1 + 0.0228 * chroma * luminance ** 0.25) / 0.0228;
  return [1.7 * lightness / (1 + 0.007 * lightness), colorfulness * Math.cos(hue), colorfulness * Math.sin(hue)];
}

// Hunt–Pointer–Estevez cone space, normalised so D65 white is (1, 1, 1).
const HPE: Matrix = [[0.4002, 0.7076, -0.0808], [-0.2263, 1.1653, 0.0457], [0, 0, 0.9182]];
const HPE_WHITE = apply(HPE, WHITE);

function lms(xyz: Vector): Vector {
  return mapVector(apply(HPE, xyz), (value, index) => value / HPE_WHITE[index]);
}

// Rec.709 R′G′B′ at display gamma 2.4, sign kept so wider gamuts overshoot instead of folding.
function rec709Encoded(xyz: Vector): Vector {
  return mapVector(apply(XYZ_TO_REC709, xyz), value => signedPow(value, 1 / 2.4));
}

// The hexagonal chroma plane every HSx model shares: red at 0°, as a vectorscope puts it near.
function hexagonalChroma([r, g, b]: Vector) {
  return [r - (g + b) / 2, Math.sqrt(3) / 2 * (g - b)] as const;
}

function ycbcr(xyz: Vector): Vector {
  const [r, g, b] = rec709Encoded(xyz);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [luma, (b - luma) / 1.8556, (r - luma) / 1.5748];
}

function hsv(xyz: Vector): Vector {
  const rgb = rec709Encoded(xyz);
  return [Math.max(...rgb), ...hexagonalChroma(rgb)];
}

function hsl(xyz: Vector): Vector {
  const rgb = rec709Encoded(xyz);
  return [(Math.max(...rgb) + Math.min(...rgb)) / 2, ...hexagonalChroma(rgb)];
}

type OpponentModel = Exclude<ColorModelId, "xyz" | "xyy" | "lms">;
const OPPONENT_MODELS: Record<OpponentModel, (xyz: Vector) => Vector> = {
  ycbcr, hsv, hsl, cielab, cieluv, ipt, oklab, ictcp, jzazbz, cam16: cam16ucs, zcam,
};

/** Coordinates of a D65 XYZ colour: lightness then two opponent axes, or the model's own three. */
export function xyzCoordinates(model: ColorModelId, xyz: Vector): Vector {
  if (model === "xyz") return xyz;
  if (model === "xyy") {
    const sum = xyz[0] + xyz[1] + xyz[2];
    return [xyz[0] / sum, xyz[1] / sum, xyz[1]];
  }
  if (model === "lms") return lms(xyz);
  return OPPONENT_MODELS[model](xyz);
}

/**
 * For linear RGB in `gamut`: XYZ or xyY under the gamut's own white, otherwise
 * lightness followed by the model's two opponent axes. Black has undefined
 * chromaticity (NaN x/y) in xyY; the wire uses directional limits at that boundary.
 */
export function modelCoordinates(gamut: GamutId, model: ColorModelId, linearRgb: Vector) {
  if (model === "xyz" || model === "xyy") return xyzCoordinates(model, apply(RGB_TO_XYZ[gamut], linearRgb));
  return xyzCoordinates(model, gamutToXyzD65(gamut, linearRgb));
}

/** One straight run of the wire: encoded RGB at each end, placed in unit model space. */
export type WireSegment = {
  from: Vector;
  to: Vector;
  color: Vector;
  edge: boolean;
};

/** A labelled coordinate axis in the same space as the wire. */
export type VolumeAxis = {
  from: Vector;
  to: Vector;
  label: string;
  ticks: { at: Vector; label: string }[];
};

export type VolumeMark = { at: Vector; label: string };

export type ColorVolume = {
  segments: WireSegment[];
  axes: VolumeAxis[];
  /** Drawn over the solid, heavier: a reference surface or path. */
  overlay?: WireSegment[];
  /** Drawn under the solid, faint. */
  reference?: WireSegment[];
  marks?: VolumeMark[];
};

export const EDGE_STEPS = 16;
const GRID_LINES = 4;
const DISPLAY_GAMMA = 2.4;
const AXIS_LABELS: Record<OpponentModel, readonly [string, string, string]> = {
  ycbcr: ["Y′", "Cb", "Cr"], hsv: ["V", "α", "β"], hsl: ["L", "α", "β"], cielab: ["L*", "a*", "b*"],
  cieluv: ["L*", "u*", "v*"], ipt: ["I", "P", "T"], oklab: ["L", "a", "b"], ictcp: ["I", "Ct", "Cp"],
  jzazbz: ["Jz", "az", "bz"], cam16: ["J′", "a′", "b′"], zcam: ["Jz", "Mz·cos", "Mz·sin"],
};
// XYZ, xyY and LMS retain their measured coordinates, with the luminance-like axis up.
const COORDINATE_SCALE = 1.2;
const COORDINATE_AXIS_LENGTH = 1.25;
const UNIT_LIMIT = 1.2;

export type CubeLine = { from: Vector; to: Vector; edge: boolean };

/** Every line of a cube face, as (start, end) corners in encoded RGB. */
export function cubeLines(gridLines = GRID_LINES) {
  const lines: CubeLine[] = [];
  const offsets = Array.from({ length: gridLines + 2 }, (_, index) => index / (gridLines + 1));
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const face of [0, 1]) {
      for (const offset of offsets) {
        for (const [fixed, free] of [[u, v], [v, u]]) {
          const start = [0, 0, 0], end = [0, 0, 0];
          start[axis] = end[axis] = face;
          start[fixed] = end[fixed] = offset;
          end[free] = 1;
          const edge = offset === 0 || offset === 1;
          lines.push({ from: start as unknown as Vector, to: end as unknown as Vector, edge });
        }
      }
    }
  }
  return lines;
}

/** Each cube line cut into `steps` runs, start and end in encoded RGB. */
export function cubeRuns(lines = cubeLines(), steps = EDGE_STEPS) {
  return lines.flatMap(line => Array.from({ length: steps }, (_, step) => ({
    start: lerpVector(line.from, line.to, step / steps),
    end: lerpVector(line.from, line.to, (step + 1) / steps),
    edge: line.edge,
  })));
}

function coordinateAxes(place: (x: number, y: number, z: number) => Vector, labels: readonly [string, string, string]): VolumeAxis[] {
  const directions = [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
  return labels.map((label, index) => {
    const along = (distance: number) => {
      const [x, y, z] = directions[index];
      return place(x * distance, y * distance, z * distance);
    };
    return {
      from: along(0), to: along(COORDINATE_AXIS_LENGTH), label,
      ticks: [0.5, 1].map(value => ({ at: along(value), label: value.toFixed(1) })),
    };
  });
}

function opponentAxes(model: OpponentModel): VolumeAxis[] {
  const [lightness, first, second] = AXIS_LABELS[model];
  return [
    { from: [0, 0, -1], to: [0, 0, 1.2], label: lightness, ticks: [] },
    { from: [-1.1, 0, 0], to: [1.1, 0, 0], label: first, ticks: [] },
    { from: [0, -1.1, 0], to: [0, 1.1, 0], label: second, ticks: [] },
  ];
}

type Polyline = { points: Vector[]; edge: boolean };
type OverlayPaths = { lines: Polyline[]; marks: { at: Vector; label: string }[] };

const OPTIMAL_RINGS = [2, 6, 12, 20, 30, 40, 50, 60, 68, 74, 78];
const OPTIMAL_MERIDIANS = 24;

// Rings of equal band width (darker to lighter) and meridians of equal band start.
function optimalPaths(): OverlayPaths {
  const count = WAVELENGTHS.length;
  const rings = OPTIMAL_RINGS.map(width => ({
    points: Array.from({ length: count + 1 }, (_, start) => optimalColor(start % count, width)), edge: false,
  }));
  const meridians = Array.from({ length: OPTIMAL_MERIDIANS }, (_, index) => {
    const start = Math.round(index * count / OPTIMAL_MERIDIANS);
    return { points: Array.from({ length: count - 1 }, (_, width) => optimalColor(start, width + 1)), edge: true };
  });
  return { lines: [...rings, ...meridians], marks: [] };
}

const POINTER_RINGS = 16, POINTER_HUES = 36;

function pointerPaths(): OverlayPaths {
  const at = (ring: number, hue: number): Vector => {
    const index = (ring * POINTER_HUES + hue % POINTER_HUES) * 3;
    return [POINTER_XYZ_D65[index], POINTER_XYZ_D65[index + 1], POINTER_XYZ_D65[index + 2]];
  };
  const rings = Array.from({ length: POINTER_RINGS }, (_, ring) => ({
    points: Array.from({ length: POINTER_HUES + 1 }, (_, hue) => at(ring, hue)), edge: ring % 5 === 0,
  }));
  const meridians = Array.from({ length: POINTER_HUES / 2 }, (_, index) => ({
    points: Array.from({ length: POINTER_RINGS }, (_, ring) => at(ring, index * 2)), edge: false,
  }));
  return { lines: [...rings, ...meridians], marks: [] };
}

const GRADIENT_STEPS = 48;
const GRADIENT_FROM: Vector = [0, 0, 1], GRADIENT_TO: Vector = [1, 1, 0];

/** Rec.709 blue to yellow three ways: as encoded values, as light, and in Oklab. */
export function gradientPaths(): OverlayPaths {
  const toXyz = (linear: Vector) => apply(REC709_TO_XYZ, linear);
  const steps = Array.from({ length: GRADIENT_STEPS + 1 }, (_, index) => index / GRADIENT_STEPS);
  const decode = (encoded: Vector) => mapVector(encoded, srgbDecode);
  const encodedFrom = mapVector(GRADIENT_FROM, srgbEncode), encodedTo = mapVector(GRADIENT_TO, srgbEncode);
  const labFrom = oklab(toXyz(GRADIENT_FROM)), labTo = oklab(toXyz(GRADIENT_TO));
  // Each label sits at its own point along the path, so the three never stack.
  const paths = [
    { label: "sRGB", along: 0.5, points: steps.map(t => toXyz(decode(lerpVector(encodedFrom, encodedTo, t)))) },
    { label: "线性", along: 0.3, points: steps.map(t => toXyz(lerpVector(GRADIENT_FROM, GRADIENT_TO, t))) },
    { label: "Oklab", along: 0.72, points: steps.map(t => oklabToXyz(lerpVector(labFrom, labTo, t))) },
  ];
  return {
    lines: paths.map(({ points }) => ({ points, edge: true })),
    marks: paths.map(({ label, along, points }) => ({ at: points[Math.round(GRADIENT_STEPS * along)], label })),
  };
}

function overlayPaths(overlay: VolumeOverlay): OverlayPaths | null {
  if (overlay === "optimal") return optimalPaths();
  if (overlay === "pointer") return pointerPaths();
  if (overlay === "gradient") return gradientPaths();
  return null;
}

/**
 * The surface of `gamut` in `model`, in unit space with z up. XYZ, xyY and LMS keep one
 * scale for every gamut. Elsewhere white sits at +1 and Rec.2020's most colourful point
 * at radius 1, so display gamuts stay comparable; anything reaching past that (AP0, a
 * camera gamut, an overlay) scales the whole drawing down to fit.
 */
export function colorVolume(gamut: GamutId, model: ColorModelId, overlay: VolumeOverlay = "none"): ColorVolume {
  const place = (from: GamutId, encoded: Vector): Vector =>
    modelCoordinates(from, model, mapVector(encoded, value => value ** DISPLAY_GAMMA));
  const runs = cubeRuns();
  const paths = overlayPaths(overlay);
  const overlayCoordinates = paths?.lines.map(line => ({ ...line, points: line.points.map(xyz => xyzCoordinates(model, xyz)) })) ?? [];
  const overlayColors = paths?.lines.map(line => line.points.map(displayRgb)) ?? [];

  function build(gamutUnit: (encoded: Vector, toward: Vector) => Vector, coordinateUnit: (coordinates: Vector) => Vector): ColorVolume {
    const segments = runs.map(({ start, end, edge }) => ({ from: gamutUnit(start, end), to: gamutUnit(end, start), color: start, edge }));
    const overlaySegments = overlayCoordinates.flatMap((line, lineIndex) => line.points.slice(1).map((point, index) => ({
      from: coordinateUnit(line.points[index]), to: coordinateUnit(point), color: overlayColors[lineIndex][index], edge: line.edge,
    })));
    const marks = paths?.marks.map(({ at, label }) => ({ at: coordinateUnit(xyzCoordinates(model, at)), label }));
    return { segments, axes: [], ...(paths ? { overlay: overlaySegments, marks } : {}) };
  }

  if (model === "xyz" || model === "lms") {
    // LMS's M, like XYZ's Y, carries most of luminance, so it stands up.
    const unit = (x: number, y: number, z: number): Vector =>
      [(x - 0.5) * COORDINATE_SCALE, (z - 0.5) * COORDINATE_SCALE, (y - 0.5) * COORDINATE_SCALE];
    const volume = build(encoded => unit(...place(gamut, encoded)), coordinates => unit(...coordinates));
    return { ...volume, axes: coordinateAxes(unit, model === "xyz" ? ["X", "Y", "Z"] : ["L", "M", "S"]) };
  }

  if (model === "xyy") {
    const unit = (x: number, y: number, luminance: number): Vector =>
      [(x - 0.5) * COORDINATE_SCALE, (y - 0.5) * COORDINATE_SCALE, (luminance - 0.5) * COORDINATE_SCALE];
    const volume = build((encoded, toward) => {
      // Black has no unique xy. Each incident edge approaches Y=0 at its own
      // chromaticity, not at the origin or white point (which would add false spokes).
      if (encoded.every(value => value === 0)) {
        const [x, y] = place(gamut, toward);
        return unit(x, y, 0);
      }
      return unit(...place(gamut, encoded));
    }, coordinates => unit(...coordinates));
    return { ...volume, axes: coordinateAxes(unit, ["x", "y", "Y"]) };
  }

  const samples = cubeLines().flatMap(line => Array.from({ length: EDGE_STEPS + 1 }, (_, step) =>
    lerpVector(line.from, line.to, step / EDGE_STEPS)));
  const radius = Math.max(...samples.map(encoded => {
    const [, a, b] = place("rec2020", encoded);
    return Math.hypot(a, b);
  }));
  const lightness = place("rec709", [1, 1, 1])[0];
  const measured = ([l, a, b]: Vector): Vector => [a / radius, b / radius, lerp(-1, 1, l / lightness)];
  const reach = [
    ...samples.map(encoded => measured(place(gamut, encoded))),
    ...overlayCoordinates.flatMap(line => line.points.map(measured)),
  ].flatMap(point => point.map(Math.abs)).filter(Number.isFinite);
  const fit = Math.min(1, UNIT_LIMIT / Math.max(...reach));
  const unit = (coordinates: Vector) => mapVector(measured(coordinates), value => value * fit);
  const volume = build(encoded => unit(place(gamut, encoded)), unit);
  return { ...volume, axes: opponentAxes(model) };
}
