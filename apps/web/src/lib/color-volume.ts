/** Gamut solids for the home diagram: RGB cubes carried through real colour coordinates. */

export const GAMUTS = ["rec709", "p3", "rec2020", "ap0"] as const;
export const COLOR_MODELS = ["xyz", "xyy", "cielab", "oklab", "ictcp", "cam16"] as const;
export type GamutId = (typeof GAMUTS)[number];
export type ColorModelId = (typeof COLOR_MODELS)[number];

export const GAMUT_LABELS: Record<GamutId, string> = { rec709: "Rec.709", p3: "P3-D65", rec2020: "Rec.2020", ap0: "ACES AP0" };
export const COLOR_MODEL_LABELS: Record<ColorModelId, string> = { xyz: "CIE XYZ", xyy: "CIE xyY", cielab: "CIELAB", oklab: "Oklab", ictcp: "ICtCp", cam16: "CAM16-UCS" };

type Vector = readonly [number, number, number];
type Matrix = readonly [Vector, Vector, Vector];

const RGB_TO_XYZ: Record<GamutId, Matrix> = {
  rec709: [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]],
  p3: [[0.4865709, 0.2656677, 0.1982173], [0.2289746, 0.6917385, 0.0792869], [0, 0.0451134, 1.0439444]],
  rec2020: [[0.636958, 0.1446169, 0.168881], [0.2627002, 0.6779981, 0.0593017], [0, 0.0280727, 1.0609851]],
  ap0: [[0.9525523959, 0, 0.0000936786], [0.3439664498, 0.7281660966, -0.0721325464], [0, 0, 1.0088251844]],
};
// AP0's white is D60. The appearance models below take D65, so it is adapted (Bradford) for them.
const D60_TO_D65: Matrix = [[0.9872662, -0.0060925, 0.0159069], [-0.0075718, 1.0018521, 0.0053143], [0.003064, -0.0050819, 1.081449]];
const XYZ_TO_REC2020: Matrix = [[1.7166512, -0.3556708, -0.2533663], [-0.6666844, 1.6164812, 0.0157685], [0.0176399, -0.0427706, 0.9421031]];
const WHITE = apply(RGB_TO_XYZ.rec709, [1, 1, 1]);
// BT.2408 reference white; ICtCp is defined on absolute luminance.
const ICTCP_WHITE_NITS = 203;

function apply(matrix: Matrix, [a, b, c]: Vector): Vector {
  return [
    matrix[0][0] * a + matrix[0][1] * b + matrix[0][2] * c,
    matrix[1][0] * a + matrix[1][1] * b + matrix[1][2] * c,
    matrix[2][0] * a + matrix[2][1] * b + matrix[2][2] * c,
  ];
}

function cielab(xyz: Vector): Vector {
  const [x, y, z] = xyz.map((value, index) => {
    const ratio = value / WHITE[index];
    return ratio > 216 / 24389 ? Math.cbrt(ratio) : (ratio * 24389 / 27 + 16) / 116;
  });
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function oklab(xyz: Vector): Vector {
  const lms = apply([[0.8189330101, 0.3618667424, -0.1288597137], [0.0329845436, 0.9293118715, 0.0361456387], [0.0482003018, 0.2643662691, 0.633851707]], xyz);
  const [l, m, s] = lms.map(Math.cbrt);
  return apply([[0.2104542553, 0.793617785, -0.0040720468], [1.9779984951, -2.428592205, 0.4505937099], [0.0259040371, 0.7827717662, -0.808675766]], [l, m, s]);
}

function pq(nits: number) {
  const m1 = 2610 / 16384, m2 = 2523 / 32, c1 = 3424 / 4096, c2 = 2413 / 128, c3 = 2392 / 128;
  const y = Math.pow(Math.max(0, nits) / 10000, m1);
  return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
}

function ictcp(xyz: Vector): Vector {
  const rgb = apply(XYZ_TO_REC2020, xyz);
  const lms = apply([[1688 / 4096, 2146 / 4096, 262 / 4096], [683 / 4096, 2951 / 4096, 462 / 4096], [99 / 4096, 309 / 4096, 3688 / 4096]], rgb);
  const [l, m, s] = lms.map(value => pq(value * ICTCP_WHITE_NITS));
  return apply([[0.5, 0.5, 0], [6610 / 4096, -13613 / 4096, 7003 / 4096], [17933 / 4096, -17390 / 4096, -543 / 4096]], [l, m, s]);
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

const APPEARANCE_MODELS: Record<Exclude<ColorModelId, "xyz" | "xyy">, (xyz: Vector) => Vector> = { cielab, oklab, ictcp, cam16: cam16ucs };

/**
 * For linear RGB in `gamut`: XYZ or xyY under the gamut's own white, otherwise
 * lightness followed by the model's two opponent axes. Black has undefined
 * chromaticity (NaN x/y) in xyY; the wire uses directional limits at that boundary.
 */
export function modelCoordinates(gamut: GamutId, model: ColorModelId, linearRgb: Vector) {
  const xyz = apply(RGB_TO_XYZ[gamut], linearRgb);
  if (model === "xyz") return xyz;
  if (model === "xyy") {
    const sum = xyz[0] + xyz[1] + xyz[2];
    return [xyz[0] / sum, xyz[1] / sum, xyz[1]] as const;
  }
  return APPEARANCE_MODELS[model](gamut === "ap0" ? apply(D60_TO_D65, xyz) : xyz);
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

export type ColorVolume = {
  segments: WireSegment[];
  axes: VolumeAxis[];
};

const EDGE_STEPS = 16;
const GRID_LINES = 4;
const DISPLAY_GAMMA = 2.4;
const AXIS_LABELS: Record<Exclude<ColorModelId, "xyz" | "xyy">, readonly [string, string, string]> = {
  cielab: ["L*", "a*", "b*"], oklab: ["L", "a", "b"], ictcp: ["I", "Ct", "Cp"], cam16: ["J′", "a′", "b′"],
};
// XYZ and xyY retain their measured coordinates, with relative luminance Y up.
const COORDINATE_SCALE = 1.2;
const COORDINATE_AXIS_LENGTH = 1.25;
const UNIT_LIMIT = 1.2;

// Every line of a cube face, as (start, end) corners in encoded RGB.
function cubeLines() {
  const lines: { from: Vector; to: Vector; edge: boolean }[] = [];
  const offsets = Array.from({ length: GRID_LINES + 2 }, (_, index) => index / (GRID_LINES + 1));
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

function opponentAxes(model: Exclude<ColorModelId, "xyz" | "xyy">): VolumeAxis[] {
  const [lightness, first, second] = AXIS_LABELS[model];
  return [
    { from: [0, 0, -1], to: [0, 0, 1.2], label: lightness, ticks: [] },
    { from: [-1.1, 0, 0], to: [1.1, 0, 0], label: first, ticks: [] },
    { from: [0, -1.1, 0], to: [0, 1.1, 0], label: second, ticks: [] },
  ];
}

/**
 * The surface of `gamut` in `model`, in unit space with z up. XYZ and xyY keep one
 * scale for every gamut. Elsewhere white sits at +1 and Rec.2020's most colourful point
 * at radius 1, so display gamuts stay comparable; AP0 reaches past that and is
 * scaled down to fit.
 */
export function colorVolume(gamut: GamutId, model: ColorModelId): ColorVolume {
  const place = (from: GamutId, encoded: Vector): Vector =>
    modelCoordinates(from, model, encoded.map(value => value ** DISPLAY_GAMMA) as unknown as Vector);
  const lines = cubeLines();
  const point = (line: (typeof lines)[number], step: number) =>
    line.from.map((value, index) => value + (line.to[index] - value) * step / EDGE_STEPS) as unknown as Vector;
  const wire = (unit: (encoded: Vector, toward: Vector) => Vector) => lines.flatMap(line => Array.from({ length: EDGE_STEPS }, (_, step) => {
    const start = point(line, step), end = point(line, step + 1);
    return { from: unit(start, end), to: unit(end, start), color: start, edge: line.edge };
  }));

  if (model === "xyz") {
    const unit = (x: number, y: number, z: number): Vector =>
      [(x - 0.5) * COORDINATE_SCALE, (z - 0.5) * COORDINATE_SCALE, (y - 0.5) * COORDINATE_SCALE];
    return { segments: wire(encoded => unit(...place(gamut, encoded))), axes: coordinateAxes(unit, ["X", "Y", "Z"]) };
  }

  if (model === "xyy") {
    const unit = (x: number, y: number, luminance: number): Vector =>
      [(x - 0.5) * COORDINATE_SCALE, (y - 0.5) * COORDINATE_SCALE, (luminance - 0.5) * COORDINATE_SCALE];
    const segments = wire((encoded, toward) => {
      // Black has no unique xy. Each incident edge approaches Y=0 at its own
      // chromaticity, not at the origin or white point (which would add false spokes).
      if (encoded.every(value => value === 0)) {
        const [x, y] = place(gamut, toward);
        return unit(x, y, 0);
      }
      return unit(...place(gamut, encoded));
    });
    return { segments, axes: coordinateAxes(unit, ["x", "y", "Y"]) };
  }

  const samples = lines.flatMap(line => Array.from({ length: EDGE_STEPS + 1 }, (_, step) => point(line, step)));
  const radius = Math.max(...samples.map(encoded => {
    const [, a, b] = place("rec2020", encoded);
    return Math.hypot(a, b);
  }));
  const lightness = place("rec709", [1, 1, 1])[0];
  const measured = (encoded: Vector): Vector => {
    const [l, a, b] = place(gamut, encoded);
    return [a / radius, b / radius, l / lightness * 2 - 1];
  };
  const fit = Math.min(1, UNIT_LIMIT / Math.max(...samples.flatMap(encoded => measured(encoded).map(Math.abs))));
  const unit = (encoded: Vector) => measured(encoded).map(value => value * fit) as unknown as Vector;
  return { segments: wire(unit), axes: opponentAxes(model) };
}
